import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "@clawdparty/contracts";
import type { ExtensionRegistry } from "../extensions/points.js";
import { type PriceTable, costOf, loadPriceTable } from "../pricing.js";
import { classifyStreamError } from "../providers/anthropic_family.js";
import type { ProviderAdapter, ProviderRequest, StopReason, Usage } from "../providers/contract.js";
import type { LoopStore, Write } from "../store/types.js";
import type { ToolContext, ToolRegistry, ToolResult } from "../tools/registry.js";
import * as checkpoint from "./checkpoint.js";
import { LoopNormalizer } from "./normalize.js";
import * as request from "./request_builder.js";
import { decide } from "./stop_reasons.js";

/**
 * The agent loop: checkpoint → assemble → stream → settle → dispatch tools →
 * settle → repeat.
 *
 * Two rules shape the structure and neither is cosmetic:
 *
 *  1. Every uncertain effect is bracketed by two commits with ids reserved BEFORE
 *     it begins, so a crash can be settled under the same identity.
 *  2. Tool results go back in a SINGLE user message, while each tool is SETTLED
 *     INDIVIDUALLY. Splitting results across messages silently trains the model to
 *     stop making parallel calls; settling them together would lose per-tool
 *     recovery. So durable settlement (per effect) and message assembly (per turn)
 *     are deliberately separate concerns.
 */

export interface RunLoopDeps {
  store: LoopStore;
  adapter: ProviderAdapter;
  tools: ToolRegistry;
  /** Emits envelopes to the transport. */
  emit(events: EventEnvelope[]): void;
  /**
   * The four extension points. `tool:before` is the command gate — without it a
   * model-directed `bash` has nothing that can refuse it, which is why this ships
   * before the harness moves to the host.
   */
  extensions?: ExtensionRegistry;
  /** Injected so a test prices a run without writing to the host's config directory. */
  priceTable?: PriceTable;
  now?: () => number;
  newId?: () => string;
}

export interface RunSpec {
  runId: string;
  sessionId: string;
  lane: string;
  prompt: string;
  requestedBy: string;
  model: string;
  cwd: string;
  systemPrompt: string;
  /**
   * Where the model-visible surface starts. 0 folds the whole session; a later
   * value severs the prior conversation without deleting it.
   */
  surfaceFrom?: number;
  effort?: import("../providers/contract.js").EffortLevel;
  disallowedTools?: string[];
  /** MCP servers whose tools this run actually loaded — echoed, so the room knows what it has. */
  connectors?: string[];
  /** Selected servers that did not load, CLASSIFIED (never the transport's own message). */
  connectorsFailed?: Array<{ name: string; kind: "not_configured" | "timeout" | "failed" }>;
  /** Skills indexed in the system prompt and loadable via the `skill` tool. */
  skills?: string[];
  /**
   * Extension contributors active for this run, by id.
   *
   * On the SNAPSHOT rather than merely in process memory: which rules were in force is part of what
   * produced a turn, so a reader of the record must be able to see it. A run whose gate was disabled
   * is a materially different run.
   */
  plugins?: string[];
  signal: AbortSignal;
}

export interface RunOutcome {
  outcome: "finished" | "failed" | "interrupted";
  uncertain: boolean;
  stopReason: string | null;
  turns: number;
}

const MAX_TURNS = 100;

export class RunLoop {
  private readonly deps: RunLoopDeps;
  private readonly now: () => number;
  private readonly newId: () => string;
  /** Fingerprint of the last emitted request snapshot; drives emit-on-change. */
  private lastSnapshot: string | null = null;
  /**
   * Mid-run follow-ups waiting to be appended.
   *
   * Replaces the deleted runner's pushable input iterable. The difference is where
   * the message lands: the old path fed it into the SDK's stream and hoped, while
   * this appends it to the RECORD, so a follow-up that arrives just before a crash
   * is still there after recovery. Drained at `end_turn` rather than mid-turn —
   * injecting into a turn already in flight would make the request unreconstructable
   * from the record.
   */
  private readonly inbox: string[] = [];
  /**
   * The host's price table, read ONCE per loop.
   *
   * Not per turn: a run must not change its pricing halfway through because the file was edited
   * mid-run, and the figure it finally reports should come from one consistent source.
   */
  private readonly priceTable: PriceTable;

  constructor(deps: RunLoopDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.newId = deps.newId ?? (() => randomUUID());
    this.priceTable = deps.priceTable ?? loadPriceTable();
  }

  async run(spec: RunSpec): Promise<RunOutcome> {
    const { store, adapter, emit } = this.deps;
    const normalizer = new LoopNormalizer(
      { sessionId: spec.sessionId, aiRunId: spec.runId, requestedBy: spec.requestedBy },
      // A READ, not an allocation: seed the normalizer from where a previous run stopped.
      // `allocateSeq` is not on LoopStore, so the loop cannot mint a seq behind the
      // normalizer's back even by accident.
      store.highestSeq(spec.runId),
    );
    const capabilities = adapter.capabilities(spec.model);

    // The prompt and run_started are recorded BEFORE anything uncertain happens,
    // so a crash in the very first request still leaves a run a reader can explain.
    const opening = [
      normalizer.userPrompt(spec.prompt, this.now()),
      // `disallowed_tools` is echoed because the contract says `run_started` carries the scope a
      // run ACTUALLY applied — and because it is the only place a late joiner, arriving by
      // backfill with no live events, can learn that a run cannot act. Omitted when nothing was
      // withheld, which is what "omitted means today's defaults" means.
      normalizer.runStarted(
        {
          model: spec.model,
          cwd: spec.cwd,
          // The lane, so the feed can label a row and a late joiner can too. Omitted for the
          // default lane: every pre-lane session is implicitly in it, and labelling every row "main"
          // in a single-lane session is noise.
          ...(spec.lane && spec.lane !== "main" ? { lane: spec.lane } : {}),
          ...(spec.disallowedTools?.length ? { disallowed_tools: spec.disallowedTools } : {}),
          ...(spec.connectors?.length ? { connectors: spec.connectors } : {}),
          ...(spec.connectorsFailed?.length ? { connectors_failed: spec.connectorsFailed } : {}),
          ...(spec.skills?.length ? { skills: spec.skills } : {}),
        },
        this.now(),
      ),
    ];
    store.commit({
      writes: [
        ...opening.map((event) =>
          this.entryFor(event, event.type === "user_prompt" ? [userBlock(spec.prompt)] : null),
        ),
        {
          kind: "register",
          op: "set",
          namespace: "run.meta",
          key: spec.runId,
          value: {
            prompt: spec.prompt,
            requestedBy: spec.requestedBy,
            provider: adapter.id,
            model: spec.model,
            cwd: spec.cwd,
            baseSha: null,
            lane: spec.lane,
          },
        },
        checkpoint.positionWrite(spec.runId, { phase: "checkpoint" }),
      ],
    });
    emit(opening);

    let turns = 0;
    let resumeAttempt = 0;
    let totalUsage: Usage = zeroUsage();

    while (turns < MAX_TURNS) {
      if (spec.signal.aborted) return this.interrupt(spec, normalizer, totalUsage);
      turns += 1;

      const turnId = this.newId();
      normalizer.beginTurn(turnId);

      const built = request.build({
        model: spec.model,
        capabilities,
        systemPrompt: spec.systemPrompt,
        tools: this.deps.tools.schemasFor(capabilities, spec.disallowedTools ?? []),
        surface: store.surfaceFrom(spec.surfaceFrom ?? 0),
        effort: spec.effort,
        signal: spec.signal,
      });

      // A model that cannot use tools at all — no transport makes this work, so unlike
      // `toolUseWhileStreaming` there is nothing for the adapter to choose. Dropping the tools
      // instead would leave a model that narrates edits it never made.
      if (!capabilities.toolUse && built.tools.length > 0) {
        return this.refuse(spec, normalizer, totalUsage, {
          provider: adapter.id,
          kind: "api_error",
          message: `${spec.model} does not support tool use; the run offered ${built.tools.length} tool(s)`,
          remedy: "Start the run with every tool disallowed, or pick a model that uses tools.",
        });
      }

      // request:before — may rewrite what is claimed, or refuse the turn outright.
      // Dispatched AFTER the request is built so a handler sees the real assembled
      // messages rather than a promise of them.
      if (this.deps.extensions) {
        const pre = await this.deps.extensions.dispatch("request:before", {
          model: spec.model,
          system: spec.systemPrompt,
          messages: [...built.messages],
          tools: [...built.tools],
          request: built,
        });
        if (pre.outcome.k === "refuse") {
          return this.refuse(spec, normalizer, totalUsage, {
            provider: adapter.id,
            kind: "api_error",
            message: `request refused by ${pre.by ?? "policy"}: ${pre.outcome.reason}`,
            remedy: "Adjust the prompt or the rule that refused it, then start a new run.",
          });
        }
      }

      const snapshotId = `${spec.runId}:${turnId}`;
      const snapshot = {
        provider: adapter.id,
        credential_source: await this.credentialSource(),
        model: spec.model,
        effort: spec.effort ?? null,
        system_prompt_digest: request.digest(spec.systemPrompt),
        tool_schemas_digest: request.digest(JSON.stringify(built.tools)),
        // The active contributor set, model-visible-and-recorded. It was an empty
        // literal, so a session that disabled a rule produced a snapshot identical to one that had
        // it on — and `request_header` is emit-on-change, so the change was invisible in the record.
        // Sorted, because the snapshot is FINGERPRINTED: iteration order must not make an unchanged
        // set look changed.
        plugins: [...(spec.plugins ?? [])].sort(),
      };

      // Emitted when ESTABLISHED OR CHANGED, not per request. A reader folds the
      // latest snapshot at or before any point, so re-stating an unchanged one adds
      // no information — it would just put 20 identical events in a 20-turn run's feed.
      const fingerprint = JSON.stringify(snapshot);
      const headerChanged = fingerprint !== this.lastSnapshot;
      // `messages_digest` rides on the PAYLOAD and is deliberately absent from `fingerprint`
      // above. The messages array grows every turn, so fingerprinting it would emit a header per
      // request — measured, and it fails behaviour_parity's "not once per request".
      const header = headerChanged
        ? normalizer.requestHeader(
            { ...snapshot, messages_digest: request.digest(JSON.stringify(built.messages)) },
            this.now(),
          )
        : null;
      this.lastSnapshot = fingerprint;

      // ── intent ──────────────────────────────────────────────────────────────
      // The settlement identity of THIS request attempt: run + snapshot + attempt is
      // stable across a crash and distinct per retry, so a retry settles under its own
      // identity rather than being rejected as a duplicate of the attempt it replaced.
      const reserved = checkpoint.reserveForRequest(
        store,
        `${spec.runId}:${snapshotId}:${resumeAttempt}`,
      );
      checkpoint.commitRequestIntent(
        store,
        spec.runId,
        { ...reserved, requestSnapshotId: snapshotId, attempt: resumeAttempt, maxAttempts: 3 },
        header ? [this.entryFor(header, null)] : [],
      );
      if (header) emit([header]);

      // The PREFIX BOUNDARY for this request, captured HERE and not before the build.
      //
      // It has to be the high-water mark AFTER the intent commit, because that commit is what
      // writes the `request_header` — and `reconstruct` REFUSES a prefix with no snapshot in it
      // (`no_snapshot`). Capturing before the build was off by one and produced exactly that
      // refusal for the first request of a run: measured 2 where the adapter saw 3.
      //
      // Recorded per turn on the usage row because `request_header` cannot carry it: headers are
      // emit-on-change, so an unchanged turn writes no marker, which is why an INTERMEDIATE request
      // previously needed its boundary handed in from outside the record.
      const prefixBoundary = store.maxStoreSeq();

      // ── the uncertainty window ──────────────────────────────────────────────
      const turn = await this.streamTurn(built, normalizer, capabilities);
      if (turn.error) {
        // An abort is not a provider fault. The signal is checked HERE as well as at the turn
        // boundary above, because an interrupt arriving MID-STREAM is only visible as a transport
        // throw — which `classifyStreamError` knows nothing about and calls `api_error`. Measured
        // on a live run: pressing Stop produced `run_failed` with no explanation (S9).
        if (spec.signal.aborted) return this.interrupt(spec, normalizer, totalUsage);
        emit([turn.error.event]);
        // The MESSAGE too. `fail()` has taken one since contract 1.12 and the settle path passes it,
        // but this path — the most common way a run dies — did not, so `run_failed.explanation` was
        // null while the words sat in `turn.error`. Measured live: a `provider_error` reading "400 The
        // provided model identifier is invalid" followed by a terminal event that said nothing.
        return this.fail(
          spec,
          normalizer,
          turn.error.stopReason,
          totalUsage,
          turn.error.explanation,
        );
      }

      totalUsage = addUsage(totalUsage, turn.usage);
      const stopReason = turn.stopReason ?? "end_turn";

      // ── settlement ──────────────────────────────────────────────────────────
      // Capabilities are passed so a REFUSAL can say whether this provider explained itself.
      // Bedrock and Converse both return a bare stop reason with no content, and the
      // sentence composed here is the only account of it the room will ever get.
      const action = decide(stopReason, resumeAttempt, capabilities.serverSideRefusalFallback);
      // `streamTurn` already withheld the deltas (broadcast live, never persisted — they
      // carry no seq, so a stored row would sit in the log with nothing to order it by), so
      // everything here is durable and every entry is a write.
      const carrier = blockCarrier(turn.durableEvents);
      const assistantWrites = turn.durableEvents.map((event, index) =>
        this.entryFor(event, index === carrier ? turn.blocks : null),
      );

      if (action.kind === "dispatch_tools") {
        const planned = checkpoint.planTools(
          `${spec.runId}:${normalizer.currentSeq()}`,
          turn.toolCalls.map((call) => ({
            toolUseId: call.id,
            name: call.name,
            replay: this.deps.tools.policyFor(call.name, call.input),
          })),
        );
        checkpoint.settle(
          store,
          spec.runId,
          [
            ...assistantWrites,
            ...usageWrites(
              spec,
              adapter.id,
              reserved.reservedUsageId,
              turn,
              this.now(),
              prefixBoundary,
            ),
          ],
          planned,
        );
        emit(turn.durableEvents);

        await this.dispatchTools(spec, normalizer, planned, turn.toolCalls);
        resumeAttempt = 0;
        continue;
      }

      checkpoint.settle(
        store,
        spec.runId,
        [
          ...assistantWrites,
          ...usageWrites(
            spec,
            adapter.id,
            reserved.reservedUsageId,
            turn,
            this.now(),
            prefixBoundary,
          ),
        ],
        { phase: "checkpoint" },
      );
      emit(turn.durableEvents);

      if (action.kind === "resume") {
        resumeAttempt = action.attempt;
        continue;
      }
      if (action.kind === "compact") {
        // Compaction is server-side, so the next request simply carries the
        // compaction block the provider returned; there is nothing local to do
        // beyond looping.
        resumeAttempt = 0;
        continue;
      }
      if (action.kind === "settle_failed") {
        return this.fail(spec, normalizer, action.stopReason, totalUsage, action.message);
      }

      // The turn is done. A follow-up that arrived while it was running extends the
      // run instead of starting a new one, which is what keeps the conversation —
      // and its prompt cache prefix — intact.
      if (this.inbox.length > 0) {
        this.appendFollowUps(spec, normalizer);
        resumeAttempt = 0;
        continue;
      }
      return this.finish(spec, normalizer, stopReason, totalUsage, turns);
    }

    return this.fail(spec, normalizer, "max_tokens", totalUsage, `exceeded ${MAX_TURNS} turns`);
  }

  /** Queue a mid-run follow-up. Applied at the next turn boundary. */
  pushMessage(text: string): void {
    this.inbox.push(text);
  }

  hasPendingMessages(): boolean {
    return this.inbox.length > 0;
  }

  /**
   * Drain the inbox into the record: one `user_prompt` event per message, each
   * carrying its text as an on-surface block so the next request includes it.
   */
  private appendFollowUps(spec: RunSpec, normalizer: LoopNormalizer): void {
    const messages = this.inbox.splice(0);
    const events = messages.map((text) => normalizer.userPrompt(text, this.now()));

    this.deps.store.commit({
      writes: [
        ...events.map((event, i) => this.entryFor(event, [userBlock(messages[i] as string)])),
        checkpoint.positionWrite(spec.runId, { phase: "checkpoint" }),
      ],
    });
    this.deps.emit(events);
  }

  /**
   * Consume one provider turn. `refusal` is checked BEFORE content is read,
   * because it arrives as HTTP 200 with possibly empty or partial content.
   */
  private async streamTurn(
    built: ProviderRequest,
    normalizer: LoopNormalizer,
    capabilities: { contextWindow: number },
  ): Promise<{
    /**
     * The turn's DURABLE events only. Ephemeral deltas are emitted as they stream (that is
     * what makes streaming live) and are deliberately absent here, so the turn-boundary
     * emit cannot send them a second time.
     */
    durableEvents: EventEnvelope[];
    blocks: unknown[];
    toolCalls: Array<{ id: string; name: string; input: unknown }>;
    usage: Usage;
    /**
     * Whether the provider actually REPORTED figures for this turn.
     *
     * Distinguished from zero because a ledger row is a statement: `0` says the turn was
     * free, which is false for any request that was made. No report means unknown, and the
     * honest record of unknown is no row at all — same rule as `RunResult.uncertain`.
     */
    usageReported: boolean;
    stopReason: StopReason | null;
    error?: { event: EventEnvelope; stopReason: string; explanation: string };
  }> {
    const durableEvents: EventEnvelope[] = [];
    const blocks: unknown[] = [];
    const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
    let usage = zeroUsage();
    let usageReported = false;
    let stopReason: StopReason | null = null;

    try {
      for await (const event of this.deps.adapter.stream(built)) {
        if (event.t === "block_stop") {
          blocks.push(event.block);
          const shape = (event.block ?? {}) as Record<string, unknown>;
          if (shape.type === "tool_use") {
            toolCalls.push({
              id: String(shape.id ?? ""),
              name: String(shape.name ?? ""),
              input: shape.input,
            });
          }
        }
        if (event.t === "message_delta") {
          stopReason = event.stopReason;
          usage = event.usage;
          usageReported = true;
          // Ephemeral, so it costs no seq — the durable figure is on the ledger.
          this.deps.emit([normalizer.contextUsage(usage, capabilities.contextWindow, this.now())]);
        }
        for (const mapped of normalizer.map(event, this.now())) {
          // Deltas go out NOW. This is the only thing that makes streaming live: everything
          // else settles at the turn boundary, and a delta that waits for it tells the room
          // nothing the durable `ai_text` beside it would not.
          //
          // They must NOT also enter `durableEvents`, which the boundary emits — the client
          // accumulates deltas, so a second copy doubles the paragraph rather than deduping.
          if (normalizer.isEphemeral(mapped.type)) this.deps.emit([mapped]);
          else durableEvents.push(mapped);
        }
      }
    } catch (err) {
      const classified = classifyStreamError(err, this.deps.adapter.failureHints);
      return {
        durableEvents,
        blocks,
        toolCalls,
        usage,
        usageReported,
        stopReason,
        error: {
          event: normalizer.providerError(
            { provider: this.deps.adapter.id, ...classified },
            this.now(),
          ),
          stopReason: classified.kind,
          // Carried so the TERMINAL event can state why the run ended. Without it `fail()` records
          // `explanation: null` and the room is left correlating two events to answer one question.
          explanation: classified.message,
        },
      };
    }

    return { durableEvents, blocks, toolCalls, usage, usageReported, stopReason };
  }

  /**
   * Dispatch a turn's tool calls, settling EACH one individually, then assemble
   * all results into ONE user message entry.
   */
  private async dispatchTools(
    spec: RunSpec,
    normalizer: LoopNormalizer,
    planned: checkpoint.ToolsPosition,
    calls: Array<{ id: string; name: string; input: unknown }>,
  ): Promise<void> {
    const { store, emit, extensions } = this.deps;
    let position = planned;

    for (const call of planned.calls) {
      const spec_ = calls.find((c) => c.id === call.toolUseId);
      const input = spec_?.input;

      // tool:before — the gate. A refusal is recorded and surfaced, never silent.
      const gated = extensions
        ? await extensions.dispatch("tool:before", {
            toolUseId: call.toolUseId,
            name: call.name,
            input,
            cwd: spec.cwd,
            runId: spec.runId,
          })
        : null;

      if (gated?.outcome.k === "refuse") {
        const refused = normalizer.toolRefused(
          call.toolUseId,
          call.name,
          gated.by ?? "policy",
          gated.outcome.reason,
          this.now(),
        );
        position = checkpoint.withCallStatus(position, call.index, "completed");
        store.commit({
          writes: [
            this.entryFor(refused, null),
            // A refusal is an OUTCOME, so it settles on the surface like any other. Held
            // in memory it would vanish on a crash and leave the call unanswered.
            this.toolResultWrite(
              spec,
              call,
              toolResultBlock(call.toolUseId, gated.outcome.reason, true),
            ),
            checkpoint.positionWrite(spec.runId, position),
          ],
        });
        emit([refused]);
        continue;
      }

      // A handler may TRANSFORM the call (e.g. narrowing a path) before it runs.
      const effectiveInput = gated?.outcome.k === "continue" ? gated.outcome.value.input : input;

      // Mark the effect pending BEFORE running it, so a crash mid-tool is
      // recoverable per the tool's own replay policy.
      position = checkpoint.withCallStatus(position, call.index, "effect_pending");
      store.commit({
        writes: [
          {
            kind: "register",
            op: "set",
            namespace: "run.tool_args",
            key: `${planned.stepId}:${call.index}`,
            value: input ?? null,
          },
          checkpoint.positionWrite(spec.runId, position),
        ],
      });

      const outcome = await this.runTool(
        spec,
        normalizer,
        call.toolUseId,
        call.name,
        effectiveInput,
      );

      // tool:after — may transform the result the MODEL sees. Observed failures are
      // contained as `continue`, so a broken transform cannot lose a tool result.
      const after = extensions
        ? await extensions.dispatch("tool:after", {
            toolUseId: call.toolUseId,
            name: call.name,
            result: outcome.result,
          })
        : null;
      const finalResult =
        after && after.outcome.k !== "refuse" ? after.outcome.value.result : outcome.result;
      const text = finalResult.content.map((c) => c.text).join("\n");

      const events = [
        ...outcome.emitted,
        finalResult.isError
          ? normalizer.toolFailed(call.toolUseId, text, this.now())
          : normalizer.toolFinished(call.toolUseId, this.now()),
      ];

      position = checkpoint.withCallStatus(position, call.index, "completed");
      store.commit({
        writes: [
          ...events.map((e) => this.entryFor(e, null)),
          this.toolResultWrite(
            spec,
            call,
            toolResultBlock(call.toolUseId, text, finalResult.isError),
          ),
          checkpoint.positionWrite(spec.runId, position),
        ],
      });
      emit(events);
    }

    // Every result is already durable and on the surface, so this only advances the
    // marker. There is nothing left to flush.
    store.commit({
      writes: [checkpoint.positionWrite(spec.runId, { phase: "checkpoint" })],
    });
  }

  /**
   * ONE surface entry per tool result, written in the SAME commit that marks the call
   * completed.
   *
   * It used to be one combined entry after EVERY call finished, with the results held in
   * memory until then. A crash in between lost them for good: recovery reads the position,
   * sees the call `completed`, and so neither re-runs nor synthesizes — the effect had
   * happened and its outcome was gone. That is the exact failure the effect sandwich
   * exists to prevent, and the crash sweep caught it at kill points 5, 6 and 7.
   *
   * Splitting them does NOT split the request message: `request_builder` merges
   * consecutive same-role surface entries, and every tool result folds to the `user` role,
   * so they still arrive as one user message. That merge is load-bearing — separate
   * messages per result silently train the model to stop making parallel calls.
   *
   * Carries the call's `settlementKey` so a settlement can only ever land once, matching
   * what recovery writes for the same call.
   */
  private toolResultWrite(spec: RunSpec, call: checkpoint.ToolCallPosition, block: unknown): Write {
    return {
      kind: "entry",
      entry: {
        run_id: spec.runId,
        // NULL seq, deliberately. `seq` is the per-run counter for the Contract-1 EVENT
        // stream, and this entry is never emitted — it is surface state for request
        // reconstruction. Taking a seq punched holes in the emitted sequence (8 -> 10),
        // which the frozen envelope rules forbid; uniqueness comes from `settlement_key`,
        // so it needs no seq at all.
        seq: null,
        settlement_key: call.settlementKey,
        type: "ai_raw",
        actor_kind: "user",
        actor_id: spec.requestedBy,
        ts_ms: this.now(),
        payload: { raw: { tool_results: 1 }, truncated: false },
        blocks: [block],
        on_surface: 1,
        emitted: 0,
      },
    };
  }

  private async runTool(
    spec: RunSpec,
    normalizer: LoopNormalizer,
    toolUseId: string,
    name: string,
    input: unknown,
  ): Promise<{ result: ToolResult; emitted: EventEnvelope[] }> {
    const tool = this.deps.tools.get(name);
    if (!tool) {
      return {
        result: { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true },
        emitted: [],
      };
    }

    const emitted: EventEnvelope[] = [];
    const ctx: ToolContext = {
      cwd: spec.cwd,
      runId: spec.runId,
      signal: spec.signal,
      // The id has to be threaded in: `terminal_output` is keyed by tool_use_id so
      // the feed can attach output to the right chip.
      onOutput: (chunk) => emitted.push(...normalizer.terminalOutput(toolUseId, chunk, this.now())),
      // Subscribed here, and this is the whole fix: only a tool that actually
      // WROTE calls this, so `file_changed` now follows the outcome. Derived from the
      // tool call it fired for a failed write too, telling the room a file changed when
      // it had not. The event consequently arrives AFTER `tool_finished` rather than
      // before it, which is why this needed a contract update rather than a patch.
      onFileChanged: (path, change) =>
        emitted.push(...[normalizer.fileChanged(toolUseId, path, change, this.now())]),
    };

    try {
      return { result: await tool.run(input, ctx), emitted };
    } catch (err) {
      return {
        result: { content: [{ type: "text", text: String(err) }], isError: true },
        emitted,
      };
    }
  }

  // --- Terminal transitions -------------------------------------------------

  private async finish(
    spec: RunSpec,
    normalizer: LoopNormalizer,
    stopReason: string,
    usage: Usage,
    turns: number,
  ): Promise<RunOutcome> {
    await this.notifyComplete(spec, { outcome: "finished", uncertain: false, turns });
    const event = normalizer.runFinished(
      {
        stop_reason: stopReason,
        num_turns: turns,
        duration_ms: 0,
        // Priced from the host's table when it has one, and NULL when it does not.
        // Still never 0 for a request that was made — that would claim it was free (v1.7).
        total_cost_usd: this.cost(spec, usage),
        usage,
      },
      this.now(),
    );
    this.terminate(spec, event, { outcome: "finished", uncertain: false, stopReason });
    return { outcome: "finished", uncertain: false, stopReason, turns };
  }

  /**
   * Refuse a turn before it is sent: PERSIST the reason, broadcast it, then fail.
   *
   * The persist is the point. `fail()` records only `run_failed`, whose payload carries a
   * stop reason and no explanation, so a `provider_error` that was merely emitted vanished on
   * restart and the record could not say why the run died. That applied to the pre-existing
   * `request:before` refusal too — both paths route through here now.
   */
  private async refuse(
    spec: RunSpec,
    normalizer: LoopNormalizer,
    usage: Usage,
    detail: Parameters<LoopNormalizer["providerError"]>[0],
  ): Promise<RunOutcome> {
    const event = normalizer.providerError(detail, this.now());
    // Not on the surface: it is a statement about the request, not part of the conversation
    // the model should see next time.
    this.deps.store.commit({ writes: [this.entryFor(event, null)] });
    this.deps.emit([event]);
    return this.fail(spec, normalizer, "refused", usage);
  }

  private async fail(
    spec: RunSpec,
    normalizer: LoopNormalizer,
    stopReason: string,
    usage: Usage,
    message?: string,
  ): Promise<RunOutcome> {
    await this.notifyComplete(spec, { outcome: "failed", uncertain: false, turns: 0 });
    const event = normalizer.runFailed(
      {
        stop_reason: stopReason,
        api_error_status: null,
        // A failed run still consumed tokens, so it still has a cost.
        total_cost_usd: this.cost(spec, usage),
        usage,
        // Was `_message` — accepted and discarded. Every `settle_failed` message the loop
        // composed was thrown away here, so the room saw "run failed" and nothing else
        // (contract 1.12).
        explanation: message ?? null,
      },
      this.now(),
    );
    this.terminate(spec, event, { outcome: "failed", uncertain: false, stopReason });
    return { outcome: "failed", uncertain: false, stopReason, turns: 0 };
  }

  private async interrupt(
    spec: RunSpec,
    normalizer: LoopNormalizer,
    usage: Usage,
  ): Promise<RunOutcome> {
    await this.notifyComplete(spec, { outcome: "interrupted", uncertain: false, turns: 0 });
    // Was `_usage` — accepted and discarded, so a run stopped after several paid turns recorded
    // no spend at all (contract 1.15).
    const event = normalizer.runInterrupted(
      { usage, total_cost_usd: this.cost(spec, usage) },
      this.now(),
    );
    this.terminate(spec, event, { outcome: "interrupted", uncertain: false, stopReason: null });
    return { outcome: "interrupted", uncertain: false, stopReason: null, turns: 0 };
  }

  /**
   * The terminal transaction: record the outcome, DELETE the `run.*` registers,
   * and set the terminal position — all at once (invariant 8). A finished session
   * holds the log, the ledger, and `lane.*`/`session.*`; no dead state.
   */
  /**
   * run:complete — OBSERVE ONLY, dispatched before the terminal transaction so a
   * handler sees the outcome while the run still exists. It cannot refuse: there is
   * nothing left to refuse, and letting it fail the terminal transaction would
   * strand the run, which is the exact failure this whole feature removes.
   */
  /**
   * What this run cost, or null when the host has no price for the model.
   *
   * The table is read ONCE per loop (`priceTable`), not per turn: a run must not change its
   * pricing halfway through because someone edited the file mid-run, and the figure a run reports
   * should come from one consistent source.
   */
  private cost(spec: RunSpec, usage: Usage): number | null {
    return costOf(spec.model, usage, this.priceTable);
  }

  private async notifyComplete(
    spec: RunSpec,
    result: { outcome: "finished" | "failed" | "interrupted"; uncertain: boolean; turns: number },
  ): Promise<void> {
    if (!this.deps.extensions) return;
    await this.deps.extensions.dispatch("run:complete", {
      runId: spec.runId,
      outcome: result.outcome,
      uncertain: result.uncertain,
      turns: result.turns,
    });
  }

  private terminate(
    spec: RunSpec,
    event: EventEnvelope,
    result: {
      outcome: "finished" | "failed" | "interrupted";
      uncertain: boolean;
      stopReason: string | null;
    },
  ): void {
    this.deps.store.commit({
      writes: [
        this.entryFor(event, null),
        { kind: "register", op: "del", namespace: "run.meta", key: spec.runId },
        {
          kind: "register",
          op: "set",
          namespace: "run.result",
          key: spec.runId,
          value: { ...result, endedAtMs: this.now() },
        },
        checkpoint.positionWrite(spec.runId, { phase: "terminal", outcome: result.outcome }),
      ],
    });
    this.deps.emit([event]);
  }

  private entryFor(event: EventEnvelope, blocks: unknown[] | null): Write {
    return {
      kind: "entry",
      entry: {
        run_id: event.ai_run_id,
        seq: event.seq,
        type: event.type,
        actor_kind: event.actor.kind,
        actor_id: event.actor.kind === "user" ? event.actor.id : null,
        ts_ms: Date.parse(event.ts),
        payload: event.payload,
        blocks,
        on_surface: blocks === null ? 0 : 1,
        // Everything reaching here came from the normalizer as an envelope, which is what
        // being emitted means. Store-only writes bypass this method entirely.
        emitted: 1,
      },
    };
  }

  private async credentialSource(): Promise<string> {
    const probe = await this.deps.adapter.probe();
    return probe.available ? probe.credentialSource : "none";
  }
}

function userBlock(text: string): unknown {
  return { type: "text", text };
}

function toolResultBlock(toolUseId: string, text: string, isError: boolean): unknown {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: [{ type: "text", text }],
    is_error: isError,
  };
}

/**
 * Which of a turn's durable entries carries the turn's verbatim blocks — EXACTLY ONE.
 *
 * The blocks are a property of the TURN, not of any single event, and the previous rule
 * ("every `ai_text`/`ai_thinking` entry gets the whole array") got both ends wrong:
 *
 *   too many  A thinking-then-text turn produced two on-surface entries each holding the
 *             full array, so every later request re-sent that turn's content TWICE. With
 *             adaptive thinking on by default this was the normal path, and byte-comparing
 *             a rebuilt request against the sent one could never see it — both sides fold
 *             the same duplicated surface.
 *   too few   A turn with only a `tool_use` block — an extremely common Claude response,
 *             with no preamble text — has neither event type, so the block reached the
 *             surface NOWHERE. The next request then carried a `tool_result` with no
 *             matching `tool_use`, which the API rejects outright.
 *
 * The FIRST claude-actored entry is the carrier: `ai_thinking`, `ai_text` and
 * `tool_started` are all `actor.kind === "claude"`, so one of them exists whenever the
 * model produced content, and `foldSurface` merges it into the assistant message in
 * provider block order.
 *
 * Returns -1 when the turn produced no claude-actored entry. A compaction-only turn is
 * that case (`context_compacted` is system-actored) and is NOT handled here — a follow-up covers it.
 */
function blockCarrier(durable: EventEnvelope[]): number {
  return durable.findIndex((event) => event.actor.kind === "claude");
}

/**
 * Zero or one usage write. NO ROW when the provider reported nothing.
 *
 * A row of zeroes is a STATEMENT that the turn was free, and no turn that made a request
 * is. The only honest record of "unknown" is silence — same reasoning as
 * `RunResult.uncertain`, which is never collapsed to false to simplify a display. An
 * adapter that forgets to emit `message_delta` should leave a visible hole in the ledger,
 * not a run that looks free.
 */
function usageWrites(
  spec: RunSpec,
  provider: string,
  id: number,
  turn: { usage: Usage; usageReported: boolean },
  nowMs: number,
  prefixBoundary: number,
): Write[] {
  if (!turn.usageReported) return [];
  return [usageWrite(spec, provider, id, turn.usage, nowMs, prefixBoundary)];
}

function usageWrite(
  spec: RunSpec,
  provider: string,
  id: number,
  usage: Usage,
  nowMs: number,
  /** Where this request's folded prefix ended — the boundary `reconstruct()` needs. */
  prefixBoundary: number,
): Write {
  return {
    kind: "usage",
    row: {
      id,
      run_id: spec.runId,
      // One write per turn, append-only, and the column was already there for exactly this link.
      // NOT put in the `request_header` payload: it changes every turn, which would defeat
      // emit-on-change and make every header a new snapshot.
      entry_store_seq: prefixBoundary,
      provider,
      model: spec.model,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read: usage.cache_read_input_tokens,
      cache_creation: usage.cache_creation_input_tokens,
      ts_ms: nowMs,
    },
  };
}

function zeroUsage(): Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  };
}
