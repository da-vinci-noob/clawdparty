import { readdir } from "node:fs/promises";
import type { EventEnvelope } from "@clawdparty/contracts";
import { activeFor, enablementWrites, handlersFor } from "./extensions/host.js";
import { ExtensionRegistry, type Handler, type PointName } from "./extensions/points.js";
import { bundledRules } from "./extensions/rules/deny_destructive_bash.js";
import { RunLoop, type RunSpec } from "./loop/run_loop.js";
import type { McpConnect } from "./mcp/client.js";
import { attachConnectors } from "./mcp/connectors.js";
import type { EffortLevel, ProviderAdapter } from "./providers/contract.js";
import { ADAPTER_IDS, adapterById, buildAdapters } from "./providers/index.js";
import { composeSystemPrompt, resolveSkills } from "./skills.js";
import { claimLane, laneScoped } from "./store/lane_scope.js";
import { type RecoveryOutcome, recoverSession } from "./store/recovery.js";
import { afterCursorToFrom, openStore } from "./store/store.js";
import type { Entry, HarnessStoreApi, LoopStore } from "./store/types.js";
import { BashTool } from "./tools/bash.js";
import * as glob from "./tools/glob.js";
import * as grep from "./tools/grep.js";
import * as read from "./tools/read.js";
import { type ToolDefinition, ToolRegistry } from "./tools/registry.js";
import * as textEditor from "./tools/text_editor.js";
import * as web from "./tools/web.js";
import type { Transport } from "./transport.js";

/**
 * Owns the live runs. Replaces the deleted `Runner`.
 *
 * The difference is not cosmetic: `Runner` held every run's state in process
 * memory and drove a vendor SDK, so a restart lost the run. The supervisor holds a
 * `RunLoop` plus its session store, and the store is the record — so what survives
 * a restart is on disk, and the in-memory map is just a handle to it.
 */

export class RunConflict extends Error {}
export class UnknownRun extends Error {}
/**
 * The caller named a provider this harness does not have.
 *
 * Typed so the route can answer 422 instead of 500. The message was already specific — it names
 * the unknown id and lists the known ones — but a caller error returned as a 500 is
 * indistinguishable from a harness fault in logs and monitoring, and it reads to the person who
 * mistyped a provider as "the server is broken" rather than "that provider does not exist".
 */
export class UnknownProvider extends Error {}

export interface StartRunInput {
  run_id: string;
  session_id: string;
  /** NEW at v1.5 — "main" until M7 gives a session more than one. */
  lane?: string;
  repo_path: string;
  prompt: string;
  requested_by: string;
  /** NEW — adapter id. `claude_session_id` is GONE; the harness owns the record. */
  provider?: string;
  model: string;
  /**
   * Whether this run inherits the session's existing conversation.
   *
   * Replaces `claude_session_id` as the carrier of the reject-severs-resume rule
   *. Rails decides it; the harness ENFORCES it by folding the surface from
   * a baseline instead of from 0 — because after a reject the recorded conversation
   * describes edits the reverted worktree no longer has, and resuming it would have
   * Claude reason about files it cannot see.
   *
   * Defaults to true: a plain follow-up continues the conversation.
   */
  resume_context?: boolean;
  effort?: EffortLevel;
  disallowed_tools?: string[];
  connectors?: string[];
  /**
   * `"all"` or specific names. The type used to be `string[]`, which could not express what Rails
   * actually sends — `harness_protocol.md` has said `"all" | string[]` all along, and the literal
   * arrived as a string the type denied was possible.
   */
  skills?: "all" | string[];
  /**
   * The AWS named profile a Bedrock run authenticates with, e.g. `claude-code-sso`.
   *
   * Per-run rather than per-process: which profile is used decides WHOSE ACCOUNT PAYS, so it
   * belongs with the run that spends it and has to be recorded alongside the provider
   *. Rails owner-gates the choice; the harness only honours it.
   */
  aws_profile?: string;
}

interface LiveRun {
  runId: string;
  sessionId: string;
  lane: string;
  loop: RunLoop;
  store: HarnessStoreApi;
  abort: AbortController;
  done: Promise<void>;
}

export interface SupervisorOptions {
  storeDir: string;
  systemPrompt?: string;
  /** Injected in tests so connector selection runs without spawning a real MCP server. */
  mcpConnect?: McpConnect;
  adapters?: Record<string, ProviderAdapter>;
  extensions?: ExtensionRegistry;
  /**
   * Injected in tests so a run does not need a live provider.
   *
   * `LoopStore`, not `HarnessStoreApi`: the loop is deliberately denied `allocateSeq` so it cannot
   * mint a seq behind the normalizer's back, and what it receives here is a lane-scoped VIEW rather
   * than the raw store. Declaring the wider type let a test builder reach past both restrictions.
   */
  buildLoop?: (deps: {
    store: LoopStore;
    adapter: ProviderAdapter;
    emit: (e: EventEnvelope[]) => void;
  }) => RunLoop;
}

/**
 * Exported so the `reconstruct` CLI can supply the SAME prompt a run used. A second copy
 * would fail its digest check on every session, which is the check working and the tool
 * being useless.
 */
/** The provider a run gets when it names none. Explicit so the default is greppable. */
const DEFAULT_PROVIDER = "anthropic-direct";

export const DEFAULT_SYSTEM_PROMPT =
  "You are Claude, working in a shared clawdparty session. Multiple people are " +
  "watching and may send follow-up messages mid-run.";

export class Supervisor {
  private readonly runs = new Map<string, LiveRun>();
  /**
   * ONE store per SESSION, shared by every lane in it — not one per run.
   *
   * The store's concurrency contract: "Concurrent lanes share one store and one
   * writer. Lanes are serialized at the commit boundary, not at the run boundary."
   * Opening per run makes the second lane collide with the first on `session.lock`,
   * which is how the concurrent-lane test failed.
   */
  private readonly stores = new Map<string, { store: HarnessStoreApi; refs: number }>();
  private readonly transport: Transport;
  private readonly opts: SupervisorOptions;
  private readonly tools: ToolRegistry;
  /**
   * The gate. Built once per supervisor so the 3-strike auto-disable is scoped to
   * the process rather than reset on every run — a rule that fails on three
   * consecutive runs is as broken as one that fails three times in one.
   */

  constructor(transport: Transport, opts: SupervisorOptions) {
    this.transport = transport;
    this.opts = opts;
    this.tools = buildRegistry();
  }

  /**
   * The  reconciliation source, and the reason `GET /runs` exists: the
   * harness's own answer to "what is running?", read from the position registers
   * rather than inferred. Rails reconciles to this — the harness wins.
   */
  activeRunIds(): string[] {
    return [...this.runs.keys()];
  }

  /** Per-run projection high-water mark, so Rails can detect lag without polling. */
  storeSeqHighWater(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [runId, run] of this.runs) out[runId] = run.store.maxStoreSeq();
    return out;
  }

  /**
   * The RE-DERIVATION source. Entries after `afterStoreSeq`, exclusive.
   *
   * Serves `projectionFrom`, not `entriesFrom`: store-only entries are surface state for
   * request reconstruction and are not events, so shipping them would project phantom
   * rows into `events`.
   *
   * Goes through `storeFor`, which returns the ALREADY-OPEN instance when the session has
   * a live run. Opening a second handle would be refused by the session lock, so a
   * re-derivation of an active session would fail for a reason that has nothing to do
   * with re-derivation.
   */
  async projectionEntries(sessionId: string, afterStoreSeq: number): Promise<Entry[]> {
    const store = await this.storeFor(sessionId);
    try {
      return store.projectionFrom(afterCursorToFrom(afterStoreSeq));
    } finally {
      await this.releaseStore(sessionId);
    }
  }

  activeRuns(): Array<{ run_id: string; session_id: string; lane: string; store_seq: number }> {
    return [...this.runs.values()].map((run) => ({
      run_id: run.runId,
      session_id: run.sessionId,
      lane: run.lane,
      store_seq: run.store.maxStoreSeq(),
    }));
  }

  async startRun(input: StartRunInput): Promise<void> {
    const lane = input.lane ?? "main";
    // One active run per LANE. Until M7 every run is on "main", so this reproduces
    // one-per-session without hardcoding that assumption.
    for (const run of this.runs.values()) {
      if (run.sessionId === input.session_id && run.lane === lane) {
        throw new RunConflict(`lane ${lane} already has an active run`);
      }
    }

    const store = await this.storeFor(input.session_id);
    const adapter = this.adapterFor(input.provider, input.aws_profile);
    const abort = new AbortController();
    const emit = (events: EventEnvelope[]) => this.ship(events, store);

    // MCP servers the run selected, connected BEFORE the first request because their tools have
    // to be declared in it. A per-run registry, not the shared one: MCP tools belong to
    // the run that enabled them, and registering into `this.tools` would leak them into every
    // later run on this harness — including runs that enabled nothing.
    const mcp = await attachConnectors({
      cwd: input.repo_path,
      names: input.connectors ?? [],
      connect: this.opts.mcpConnect,
    });
    for (const failure of mcp.failed) {
      // The RAW reason goes here and nowhere else. It is a message from a transport we do not
      // control, so it could carry a URL with a token in it; the event stream gets a
      // classification instead, the same way the connector listing withholds every server's
      // command/url/headers.
      process.stderr.write(`connector ${failure.server} not loaded: ${failure.reason}\n`);
    }
    // Skills the run selected: an INDEX in the system prompt plus a `skill` tool to load a body on
    // demand. Inlining every SKILL.md was never viable — 79 skills on this host — and the
    // index keeps the cost proportional to what the model actually opens.
    const skills = resolveSkills(input.repo_path, input.skills ?? [], undefined);
    const extraTools = [...mcp.tools, ...(skills.tool ? [skills.tool] : [])];
    const tools = extraTools.length === 0 ? this.tools : registryWith(extraTools);

    // The loop writes through a LANE-SCOPED view. One store serves every lane in the
    // session, so the lane cannot live on the store — and stamping it at each of the loop's eleven
    // commit sites is a design where missing one is silent: the leaf simply stops advancing.
    const laneStore = laneScoped(store, lane);
    claimLane(laneStore, lane, input.run_id);

    // The contributor set is PER SESSION: a session that disabled a rule must not get
    // it, so the registry is built from what that session has enabled rather than from the shared
    // one. An INJECTED registry still wins outright, which is what test doubles rely on.
    const active = activeFor(store, input.session_id);
    const extensions = this.opts.extensions ?? registryOf(handlersFor(store, input.session_id));

    const loop = this.opts.buildLoop
      ? this.opts.buildLoop({ store: laneStore, adapter, emit })
      : new RunLoop({ store: laneStore, adapter, tools, emit, extensions });

    const spec: RunSpec = {
      runId: input.run_id,
      sessionId: input.session_id,
      lane,
      // Severing the chain is expressed as a surface BASELINE rather than by
      // deleting anything: the log stays intact and readable, the next request
      // just starts folding after it.
      surfaceFrom: input.resume_context === false ? store.maxStoreSeq() + 1 : 0,
      prompt: input.prompt,
      requestedBy: input.requested_by,
      model: input.model,
      cwd: input.repo_path,
      // Composed, and RECOMPOSABLE: `reconstruct` verifies the recorded digest against a prompt it
      // rebuilds from `run_started`'s cwd + resolved skill names, so a skill run does not read as a
      // digest mismatch forever.
      systemPrompt: composeSystemPrompt(
        this.opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        skills.index,
      ),
      effort: input.effort,
      disallowedTools: input.disallowed_tools,
      // Only the servers whose tools actually LOADED. A connector that failed to start is absent
      // from the echo, which is the honest record: the run does not have it.
      connectors: mcp.loaded,
      skills: skills.names,
      // Recorded on the snapshot, so the record can say which rules were in force for this turn.
      plugins: active.map((plugin) => plugin.id),
      connectorsFailed: mcp.failed.map((failure) => ({
        name: failure.server,
        kind: classifyConnectorFailure(failure.reason),
      })),
      signal: abort.signal,
    };

    const done = loop
      .run(spec)
      .then(() => undefined)
      .finally(async () => {
        this.runs.delete(input.run_id);
        // Release the lane in the RECORD, not just in memory: the in-memory map dies with the
        // process, and a `lane.state` still naming a finished run would make recovery think the
        // lane was occupied.
        claimLane(laneStore, lane, null);
        // Before releasing the store, so a stdio server never outlives the run that spawned it.
        await mcp.close();
        void this.releaseStore(input.session_id);
      });

    this.runs.set(input.run_id, {
      runId: input.run_id,
      sessionId: input.session_id,
      lane,
      loop,
      store,
      abort,
      done,
    });
  }

  sendMessage(runId: string, message: string): void {
    this.requireActive(runId).loop.pushMessage(message);
  }

  async interrupt(runId: string): Promise<void> {
    const run = this.requireActive(runId);
    run.abort.abort();
    await run.done;
  }

  /** Heartbeat each SESSION lock once, so a live writer is never reclaimed as stale. */
  heartbeat(): void {
    for (const entry of this.stores.values()) entry.store.heartbeat();
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.runs.values()].map(async (run) => {
        run.abort.abort();
        await run.done.catch(() => undefined);
      }),
    );
  }

  /** Which contributors a session has on, for `GET /plugins`. */
  async activePlugins(sessionId: string): Promise<string[]> {
    const store = await this.storeFor(sessionId);
    try {
      return activeFor(store, sessionId).map((plugin) => plugin.id);
    } finally {
      void this.releaseStore(sessionId);
    }
  }

  /**
   * Enable or disable a contributor for a session, durably.
   *
   * Writes the RECORD only. The `plugin_enabled`/`plugin_disabled` EVENT is appended by Rails, which
   * is the established shape for a session-scoped occurrence — `skill_changed` works the same way
   * (`skills_controller.rb`), and the reason is structural: the harness owns the per-RUN `seq` space
   * and a plugin toggle belongs to no run, so it has no seq to allocate. Rails owns `events` and
   * `Events::Append`, which appends and broadcasts in one transaction.
   *
   * The DESCRIPTOR is copied into the register rather than referenced , so a session stays
   * readable after a contributor leaves the build.
   */
  async setPluginEnabled(
    sessionId: string,
    pluginId: string,
    enabled: boolean,
  ): Promise<{ ok: true; active: string[] } | { ok: false; reason: string }> {
    const store = await this.storeFor(sessionId);
    try {
      const planned = enablementWrites(store, sessionId, pluginId, enabled);
      if (!planned.ok) return planned;

      store.commit({ writes: planned.writes });
      // Returned so Rails can put the resolved set on its event without asking again — and so a
      // caller sees what the toggle actually produced rather than what it requested.
      return { ok: true, active: activeFor(store, sessionId).map((plugin) => plugin.id) };
    } finally {
      void this.releaseStore(sessionId);
    }
  }

  /** Open the session's store, or share the one already open, refcounted by lane. */
  private async storeFor(sessionId: string): Promise<HarnessStoreApi> {
    const existing = this.stores.get(sessionId);
    if (existing) {
      existing.refs += 1;
      return existing.store;
    }

    const opened = await openStore(sessionId, { dir: this.opts.storeDir });
    if (!opened.ok) {
      const detail =
        opened.reason === "locked" ? `held by pid ${opened.heldBy.pid}` : opened.reason;
      throw new Error(`store unavailable for session ${sessionId}: ${detail}`);
    }
    this.stores.set(sessionId, { store: opened.store, refs: 1 });
    return opened.store;
  }

  /**
   * BOOT RECOVERY. Scan every session store and recover each run that
   * still holds a live `run.position`, BEFORE the server starts serving.
   *
   * Ordering is the point. Rails reconciles against `GET /runs` at boot  and an
   * unreachable-or-empty answer reconciles nothing, so serving first would let Rails
   * see zero active runs and fail runs the harness was about to recover.
   *
   * A store held by another live harness is SKIPPED, not forced: the lock means someone
   * else owns that record, and stealing it would give one run two writers.
   */
  async recoverAll(): Promise<Array<{ sessionId: string; outcome: RecoveryOutcome }>> {
    const results: Array<{ sessionId: string; outcome: RecoveryOutcome }> = [];
    for (const sessionId of await listSessionIds(this.opts.storeDir)) {
      let store: HarnessStoreApi;
      try {
        store = await this.storeFor(sessionId);
      } catch {
        // Locked or corrupt. Reported by the caller's log, never fatal — one bad store
        // must not stop the rest of the sessions from recovering.
        continue;
      }
      try {
        for (const outcome of await recoverSession(store, { now: () => Date.now() })) {
          // recovery.ts does not know the session; stamp it so the envelope is routable.
          this.ship(
            outcome.events.map((event) => ({ ...event, session_id: sessionId })),
            store,
          );
          results.push({ sessionId, outcome });
        }
      } finally {
        await this.releaseStore(sessionId);
      }
    }
    return results;
  }

  /** Close only when the LAST lane in the session is done. */
  private async releaseStore(sessionId: string): Promise<void> {
    const entry = this.stores.get(sessionId);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    this.stores.delete(sessionId);
    await entry.store.close();
  }

  /**
   * Resolve a provider id through the REGISTRY, with no id branching of its own.
   *
   * This used to be an `if (id === "anthropic-direct")` chain, which would have needed a
   * new arm per adapter — the exact shape  forbids in the loop and there is no reason
   * to tolerate one arm above it.
   */
  private adapterFor(provider: string | undefined, awsProfile?: string): ProviderAdapter {
    const id = provider ?? DEFAULT_PROVIDER;
    const configured = this.opts.adapters?.[id];
    if (configured) return configured;

    const adapter = adapterById(id, buildAdapters({ awsProfile }));
    if (adapter) return adapter;
    // Named, never defaulted: running someone's prompt on a provider they did not choose
    // bills an account they did not pick.
    throw new UnknownProvider(`unknown provider: ${id}. Known: ${ADAPTER_IDS.join(", ")}`);
  }

  /**
   * Ship a batch, routing durable and ephemeral down their different paths and
   * attaching `store_seq` to the durable ones so Rails can re-derive the projection
   * from `entriesFrom()` after an outage.
   *
   * Ephemeral events get no `store_seq` because they were never persisted to have
   * one — and they must not be buffered or retried, since a stale delta replayed
   * after the durable block has settled would corrupt the accumulator.
   */
  private ship(events: EventEnvelope[], store: HarnessStoreApi): void {
    const highWater = store.maxStoreSeq();
    const durable: EventEnvelope[] = [];

    for (const event of events) {
      if (event.seq === null) void this.transport.deliverEphemeral(event);
      else durable.push({ ...event, store_seq: highWater });
    }
    if (durable.length > 0) void this.transport.deliverDurable(durable);
  }

  private requireActive(runId: string): LiveRun {
    const run = this.runs.get(runId);
    if (!run) throw new UnknownRun(runId);
    return run;
  }
}

/** The bundled rules, registered through the same contract a plugin would use. */
export function buildExtensions(): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  for (const rule of bundledRules) registry.register(rule);
  return registry;
}

/**
 * A registry holding exactly these handlers — the per-session set.
 *
 * A fresh registry per run rather than unregistering from a shared one: strikes and auto-disable
 * state live on the registry , and carrying one session's strike history into another would
 * disable a contributor for a room that never saw it fail.
 */
function registryOf(handlers: Array<Handler<PointName>>): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  for (const handler of handlers) registry.register(handler);
  return registry;
}

/** The base registry plus this run's MCP tools. A COPY, so nothing leaks into the next run. */
function registryWith(extra: readonly ToolDefinition[]): ToolRegistry {
  const registry = buildRegistry();
  for (const tool of extra) registry.register(tool);
  return registry;
}

/**
 * A connect failure, classified for the record.
 *
 * Three kinds because three things need different remedies: the host never configured it, it is
 * there but did not answer in time, or it answered with a refusal. Anything else is `failed` —
 * a classification that says "we do not know why" beats inventing a reason.
 */
function classifyConnectorFailure(reason: string): "not_configured" | "timeout" | "failed" {
  if (reason.includes("not configured")) return "not_configured";
  if (reason.includes("did not respond")) return "timeout";
  return "failed";
}

export function buildRegistry(): ToolRegistry {
  // `origin` is stamped HERE rather than in each tool file: it describes how a tool reached the
  // registry, which is this function's business, and one place cannot drift from five.
  const builtIn = (tool: ToolDefinition): ToolDefinition => ({ origin: "built-in", ...tool });
  const registry = new ToolRegistry()
    .register(builtIn(new BashTool().definition))
    .register(builtIn(textEditor.definition))
    .register(builtIn(read.definition))
    .register(builtIn(glob.definition))
    .register(builtIn(grep.definition));
  for (const tool of web.definitions) registry.register(builtIn(tool));
  return registry;
}

/**
 * Session ids from the store directory. Stores are `session-<id>.sqlite3`, so the
 * filesystem IS the session index — there is no registry to fall out of sync with it.
 * A missing directory means a first-ever boot, not an error.
 */
async function listSessionIds(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names
      .filter((name) => name.startsWith("session-") && name.endsWith(".sqlite3"))
      .map((name) => name.slice("session-".length, -".sqlite3".length));
  } catch {
    return [];
  }
}
