import { readdir } from "node:fs/promises";
import type { EventEnvelope } from "@clawdparty/contracts";
import { ExtensionRegistry } from "./extensions/points.js";
import { bundledRules } from "./extensions/rules/deny_destructive_bash.js";
import { RunLoop, type RunSpec } from "./loop/run_loop.js";
import { AnthropicDirectAdapter } from "./providers/anthropic_direct.js";
import type { EffortLevel, ProviderAdapter } from "./providers/contract.js";
import { type RecoveryOutcome, recoverSession } from "./store/recovery.js";
import { openStore } from "./store/store.js";
import type { HarnessStoreApi } from "./store/types.js";
import { BashTool } from "./tools/bash.js";
import * as glob from "./tools/glob.js";
import * as grep from "./tools/grep.js";
import * as read from "./tools/read.js";
import { ToolRegistry } from "./tools/registry.js";
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
  allowed_tools?: string[];
  disallowed_tools?: string[];
  connectors?: string[];
  skills?: string[];
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
  adapters?: Record<string, ProviderAdapter>;
  extensions?: ExtensionRegistry;
  /** Injected in tests so a run does not need a live provider. */
  buildLoop?: (deps: {
    store: HarnessStoreApi;
    adapter: ProviderAdapter;
    emit: (e: EventEnvelope[]) => void;
  }) => RunLoop;
}

const DEFAULT_SYSTEM_PROMPT =
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
  private readonly extensions: ExtensionRegistry;

  constructor(transport: Transport, opts: SupervisorOptions) {
    this.transport = transport;
    this.opts = opts;
    this.tools = buildRegistry();
    this.extensions = opts.extensions ?? buildExtensions();
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
    const adapter = this.adapterFor(input.provider);
    const abort = new AbortController();
    const emit = (events: EventEnvelope[]) => this.ship(events, store);
    const loop = this.opts.buildLoop
      ? this.opts.buildLoop({ store, adapter, emit })
      : new RunLoop({ store, adapter, tools: this.tools, emit, extensions: this.extensions });

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
      systemPrompt: this.opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      effort: input.effort,
      disallowedTools: input.disallowed_tools,
      signal: abort.signal,
    };

    const done = loop
      .run(spec)
      .then(() => undefined)
      .finally(() => {
        this.runs.delete(input.run_id);
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

  private adapterFor(provider: string | undefined): ProviderAdapter {
    const id = provider ?? "anthropic-direct";
    const configured = this.opts.adapters?.[id];
    if (configured) return configured;
    if (id === "anthropic-direct") return new AnthropicDirectAdapter();
    throw new Error(`unknown provider: ${id}`);
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

export function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
    .register(new BashTool().definition)
    .register(textEditor.definition)
    .register(read.definition)
    .register(glob.definition)
    .register(grep.definition);
  for (const tool of web.definitions) registry.register(tool);
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
