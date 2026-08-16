import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "@clawdparty/contracts";
import type { ExtensionRegistry } from "../extensions/points.js";
import type { ProviderAdapter, ProviderRequest, StopReason, Usage } from "../providers/contract.js";
import type { HarnessStoreApi, Write } from "../store/types.js";
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
  store: HarnessStoreApi;
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

  constructor(deps: RunLoopDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.newId = deps.newId ?? (() => randomUUID());
  }

  async run(spec: RunSpec): Promise<RunOutcome> {
    const { store, adapter, emit } = this.deps;
    const normalizer = new LoopNormalizer(
      { sessionId: spec.sessionId, aiRunId: spec.runId, requestedBy: spec.requestedBy },
      store.nextSeq(spec.runId) - 1,
    );
    const capabilities = adapter.capabilities(spec.model);

    // The prompt and run_started are recorded BEFORE anything uncertain happens,
    // so a crash in the very first request still leaves a run a reader can explain.
    const opening = [
      normalizer.userPrompt(spec.prompt, this.now()),
      normalizer.runStarted(
        { model: spec.model, cwd: spec.cwd, permission_mode: "", claude_session_id: "" },
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
          const event = normalizer.providerError(
            {
              provider: adapter.id,
              kind: "api_error",
              message: `request refused by ${pre.by ?? "policy"}: ${pre.outcome.reason}`,
              remedy: "Adjust the prompt or the rule that refused it, then start a new run.",
            },
            this.now(),
          );
          emit([event]);
          return this.fail(spec, normalizer, "refused", totalUsage);
        }
      }

      const snapshotId = `${spec.runId}:${turnId}`;
      const snapshot = {
        provider: adapter.id,
        credential_source: await this.credentialSource(),
        model: spec.model,
        effort: spec.effort ?? null,
        system_prompt_digest: digest(spec.systemPrompt),
        tool_schemas_digest: digest(JSON.stringify(built.tools)),
        plugins: [] as string[],
      };

      // Emitted when ESTABLISHED OR CHANGED, not per request (the design record's
      // "Request snapshot"). A reader folds the latest snapshot at or before any
      // point, so re-stating an unchanged one adds no information — it would just
      // put 20 identical events in a 20-turn run's feed.
      const fingerprint = JSON.stringify(snapshot);
      const headerChanged = fingerprint !== this.lastSnapshot;
      const header = headerChanged ? normalizer.requestHeader(snapshot, this.now()) : null;
      this.lastSnapshot = fingerprint;

      // ── intent ──────────────────────────────────────────────────────────────
      const reserved = checkpoint.reserveForRequest(store, spec.runId);
      checkpoint.commitRequestIntent(
        store,
        spec.runId,
        { ...reserved, requestSnapshotId: snapshotId, attempt: resumeAttempt, maxAttempts: 3 },
        header ? [this.entryFor(header, null)] : [],
      );
      if (header) emit([header]);

      // ── the uncertainty window ──────────────────────────────────────────────
      const turn = await this.streamTurn(built, normalizer, capabilities);
      if (turn.error) {
        emit([turn.error.event]);
        return this.fail(spec, normalizer, turn.error.stopReason, totalUsage);
      }

      totalUsage = addUsage(totalUsage, turn.usage);
      const stopReason = turn.stopReason ?? "end_turn";

      // ── settlement ──────────────────────────────────────────────────────────
      const action = decide(stopReason, resumeAttempt);
      const assistantWrites = turn.events.map((event) =>
        this.entryFor(
          event,
          event.type === "ai_text" || event.type === "ai_thinking" ? turn.blocks : null,
        ),
      );

      if (action.kind === "dispatch_tools") {
        const planned = checkpoint.planTools(
          store,
          spec.runId,
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
            usageWrite(spec, adapter.id, reserved.reservedUsageId, turn.usage, this.now()),
          ],
          planned,
        );
        emit(turn.events);

        await this.dispatchTools(spec, normalizer, planned, turn.toolCalls);
        resumeAttempt = 0;
        continue;
      }

      checkpoint.settle(
        store,
        spec.runId,
        [
          ...assistantWrites,
          usageWrite(spec, adapter.id, reserved.reservedUsageId, turn.usage, this.now()),
        ],
        { phase: "checkpoint" },
      );
      emit(turn.events);

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
    events: EventEnvelope[];
    blocks: unknown[];
    toolCalls: Array<{ id: string; name: string; input: unknown }>;
    usage: Usage;
    stopReason: StopReason | null;
    error?: { event: EventEnvelope; stopReason: string };
  }> {
    const events: EventEnvelope[] = [];
    const blocks: unknown[] = [];
    const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
    let usage = zeroUsage();
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
          // Ephemeral, so it costs no seq — the durable figure is on the ledger.
          this.deps.emit([normalizer.contextUsage(usage, capabilities.contextWindow, this.now())]);
        }
        events.push(...normalizer.map(event, this.now()));
      }
    } catch (err) {
      const classified = classifyStreamError(err);
      return {
        events,
        blocks,
        toolCalls,
        usage,
        stopReason,
        error: {
          event: normalizer.providerError(
            { provider: this.deps.adapter.id, ...classified },
            this.now(),
          ),
          stopReason: classified.kind,
        },
      };
    }

    return { events, blocks, toolCalls, usage, stopReason };
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
    const resultBlocks: unknown[] = [];
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
          writes: [this.entryFor(refused, null), checkpoint.positionWrite(spec.runId, position)],
        });
        emit([refused]);
        resultBlocks.push(toolResultBlock(call.toolUseId, gated.outcome.reason, true));
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
          checkpoint.positionWrite(spec.runId, position),
        ],
      });
      emit(events);
      resultBlocks.push(toolResultBlock(call.toolUseId, text, finalResult.isError));
    }

    // ONE user message carrying every result. Splitting these silently trains the
    // model to stop making parallel calls.
    store.commit({
      writes: [
        {
          kind: "entry",
          entry: {
            run_id: spec.runId,
            seq: store.nextSeq(spec.runId),
            type: "ai_raw",
            actor_kind: "user",
            actor_id: spec.requestedBy,
            ts_ms: this.now(),
            payload: { raw: { tool_results: resultBlocks.length }, truncated: false },
            blocks: resultBlocks,
            on_surface: 1,
          },
        },
        checkpoint.positionWrite(spec.runId, { phase: "checkpoint" }),
      ],
    });
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
      // `onFileChanged` is deliberately NOT subscribed: `file_changed` is derived
      // from the tool CALL in the normalizer, so subscribing here emitted it twice.
      // A failed write therefore still reports a file as changed — fixed by a follow-up,
      // which owns the behaviour change and the contract update it needs.
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
      { stop_reason: stopReason, num_turns: turns, duration_ms: 0, total_cost_usd: 0, usage },
      this.now(),
    );
    this.terminate(spec, event, { outcome: "finished", uncertain: false, stopReason });
    return { outcome: "finished", uncertain: false, stopReason, turns };
  }

  private async fail(
    spec: RunSpec,
    normalizer: LoopNormalizer,
    stopReason: string,
    usage: Usage,
    _message?: string,
  ): Promise<RunOutcome> {
    await this.notifyComplete(spec, { outcome: "failed", uncertain: false, turns: 0 });
    const event = normalizer.runFailed(
      { stop_reason: stopReason, api_error_status: null, total_cost_usd: 0, usage },
      this.now(),
    );
    this.terminate(spec, event, { outcome: "failed", uncertain: false, stopReason });
    return { outcome: "failed", uncertain: false, stopReason, turns: 0 };
  }

  private async interrupt(
    spec: RunSpec,
    normalizer: LoopNormalizer,
    _usage: Usage,
  ): Promise<RunOutcome> {
    await this.notifyComplete(spec, { outcome: "interrupted", uncertain: false, turns: 0 });
    const event = normalizer.runInterrupted(this.now());
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

function usageWrite(
  spec: RunSpec,
  provider: string,
  id: number,
  usage: Usage,
  nowMs: number,
): Write {
  return {
    kind: "usage",
    row: {
      id,
      run_id: spec.runId,
      entry_store_seq: null,
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

/** A provider failure always names a remedy — a generic message violates. */
function classifyStreamError(err: unknown): { kind: string; message: string; remedy: string } {
  const status = (err as { status?: number } | null)?.status;
  if (status === 401) {
    return {
      kind: "credential_expired",
      message: "the provider rejected the credential (401)",
      remedy: "Refresh the credential — `claude setup-token` or a new API key.",
    };
  }
  if (status === 429) {
    return {
      kind: "api_error",
      message: "rate limited (429)",
      remedy: "Wait and retry; reduce concurrent runs if this persists.",
    };
  }
  return {
    kind: "api_error",
    message: String(err),
    remedy: "Check network access to the provider and retry the run.",
  };
}

function digest(value: string): string {
  // Not cryptographic — this only has to prove which version was used, and a full
  // hash import for that would be noise. Deterministic and stable is enough.
  let hash = 5381;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  return `djb2:${(hash >>> 0).toString(16)}`;
}
