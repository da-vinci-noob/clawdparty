import type { Actor, EnvelopeType, EventEnvelope } from "@clawdparty/contracts";
import { EPHEMERAL_EVENT_TYPES } from "@clawdparty/contracts";
import type { ProviderEvent, Usage } from "../providers/contract.js";
import { boundRawPayload, isoMs, summarizeToolInput } from "../redaction.js";

/**
 * Maps `ProviderEvent` — the harness's own provider-neutral stream — to Contract-1
 * envelopes.
 *
 * Replaces the Agent-SDK message mapping. The old normalizer translated whatever
 * a vendor SDK happened to emit; this translates a shape the harness defines, so
 * the mapping is total by construction rather than by defensive guessing. The
 * `ai_raw` never-crash valve is kept anyway, because a provider can still stream
 * something the adapter did not recognise.
 *
 * ── BLOCK KEY: `"<turnId>:<index>"` ────────────────────────────────────────────
 * The contract (`events.md` §6, `AiTextDeltaPayload`) and the fixture both specify
 * `"<assistant_message_uuid>:<content_block_index>"`. The OLD normalizer instead
 * emitted `"<message.id>:<block_kind>"` — e.g. `M1:thinking`. That drift survived
 * because each guard checked the half the other did not: the fixture test skips
 * payload internals, and the normalizer cross-check compares only type sequences.
 *
 * Index-based is implemented here, and not merely because the contract says so:
 * kind-based COLLIDES when one turn emits two text blocks, and the reducer would
 * concatenate unrelated text under a single key. `ProviderEvent` carries `index`
 * natively, so the correct scheme is also the natural one.
 *
 * `turnId` is HARNESS-generated rather than a vendor message id. It has to be
 * known before the response arrives (the record needs the key) and it has to
 * survive a crash, so it is minted with the turn and recorded — a vendor id
 * satisfies neither.
 */

const EPHEMERAL = new Set<EnvelopeType>(EPHEMERAL_EVENT_TYPES);

export const TERMINAL_CHUNK_BYTES = 64 * 1024;

export interface NormalizeContext {
  sessionId: string;
  aiRunId: string;
  /** For `run_started` / `run_interrupted` / `user_prompt` attribution. */
  requestedBy?: string;
}

export interface BlockAccumulator {
  kind: "text" | "thinking" | "tool_use" | "compaction";
  text: string;
  partialJson: string;
}

/**
 * Turns a provider stream into envelopes, assigning per-run `seq`.
 *
 * `seq` is assigned HERE and nowhere else, because it is per-run monotonic and
 * durable-only — an ephemeral event must not consume one. Splitting that decision
 * across producers is how a gap or a duplicate gets introduced.
 */
export class LoopNormalizer {
  private seq: number;
  private readonly ctx: NormalizeContext;
  private turnId: string;
  private readonly blocks = new Map<number, BlockAccumulator>();
  private readonly toolNames = new Map<string, string>();

  constructor(ctx: NormalizeContext, startSeq = 0) {
    this.ctx = ctx;
    this.seq = startSeq;
    this.turnId = "turn";
  }

  /** Called by the loop when a turn begins, so the key survives recovery. */
  beginTurn(turnId: string): void {
    this.turnId = turnId;
    this.blocks.clear();
  }

  currentSeq(): number {
    return this.seq;
  }

  /**
   * Take `count` ids for entries the LOOP writes directly rather than emitting as events
   * (the per-call tool-result surface entries).
   *
   * Here because of the rule at the top of this file: seq is assigned in one place. The
   * loop first allocated these from `store.nextSeq`, which reads MAX(seq) — and in a
   * commit that also carries normalizer-seq'd events, those rows are not inserted yet, so
   * it handed back an id one of them was about to use and `UNIQUE (run_id, seq)` dropped
   * the surface entry SILENTLY. Same two-allocator bug as the earlier one, one commit later.
   */
  takeSeqs(count: number): number[] {
    const ids: number[] = [];
    for (let i = 0; i < count; i += 1) ids.push(++this.seq);
    return ids;
  }

  isEphemeral(type: EnvelopeType): boolean {
    return EPHEMERAL.has(type);
  }

  blockKey(index: number): string {
    return `${this.turnId}:${index}`;
  }

  /**
   * One provider event to zero or more envelopes. Never throws — an unmapped shape
   * becomes `ai_raw` rather than taking the run down.
   */
  map(event: ProviderEvent, nowMs: number = Date.now()): EventEnvelope[] {
    try {
      return this.mapInner(event, nowMs);
    } catch (err) {
      return [this.aiRaw({ event, error: String(err) }, nowMs)];
    }
  }

  private mapInner(event: ProviderEvent, nowMs: number): EventEnvelope[] {
    switch (event.t) {
      case "message_start":
        return [];

      case "block_start":
        this.blocks.set(event.index, { kind: event.kind, text: "", partialJson: "" });
        return [];

      case "text_delta": {
        this.accumulate(event.index, "text", event.text);
        return [
          this.envelope(
            "ai_text_delta",
            { kind: "claude" },
            { block: this.blockKey(event.index), text: event.text },
            nowMs,
          ),
        ];
      }

      case "thinking_delta": {
        this.accumulate(event.index, "thinking", event.text);
        return [
          this.envelope(
            "ai_thinking_delta",
            { kind: "claude" },
            { block: this.blockKey(event.index), text: event.text },
            nowMs,
          ),
        ];
      }

      case "tool_input_delta": {
        const acc = this.blocks.get(event.index);
        if (acc) acc.partialJson += event.partialJson;
        // Not surfaced: a partially-parsed tool input is not something a
        // participant can act on, and `tool_started` carries the summary.
        return [];
      }

      case "block_stop":
        return this.mapBlockStop(event.index, event.block, nowMs);

      case "message_delta":
        // Usage rides the run-completion events; the loop settles the ledger.
        return [];

      case "message_stop":
        return [];

      case "raw":
        return [this.aiRaw(event.value, nowMs)];
    }
  }

  /**
   * The durable record of a completed block. The accumulated deltas are the
   * fallback for text, because a provider may finalize a thinking block as
   * signature-only with empty text.
   */
  private mapBlockStop(index: number, block: unknown, nowMs: number): EventEnvelope[] {
    const acc = this.blocks.get(index);
    const shape = (block ?? {}) as Record<string, unknown>;
    const kind = acc?.kind ?? inferKind(shape);

    if (kind === "text") {
      const text = firstNonEmpty(String(shape.text ?? ""), acc?.text ?? "");
      return [
        this.envelope("ai_text", { kind: "claude" }, { block: this.blockKey(index), text }, nowMs),
      ];
    }

    if (kind === "thinking") {
      const text = firstNonEmpty(String(shape.thinking ?? ""), acc?.text ?? "");
      return [
        this.envelope(
          "ai_thinking",
          { kind: "claude" },
          { block: this.blockKey(index), text },
          nowMs,
        ),
      ];
    }

    if (kind === "compaction") {
      // every summarization is recorded. The block itself is stored
      // verbatim by the loop; this event is what the feed renders.
      return [
        this.envelope(
          "context_compacted",
          { kind: "system" },
          {
            replaced_from_seq: Number(shape.replaced_from_seq ?? 0),
            replaced_to_seq: Number(shape.replaced_to_seq ?? 0),
            tokens_before: Number(shape.tokens_before ?? 0),
            summary_present: typeof shape.summary === "string" && shape.summary.length > 0,
          },
          nowMs,
        ),
      ];
    }

    return this.mapToolUse(shape, nowMs);
  }

  private mapToolUse(shape: Record<string, unknown>, nowMs: number): EventEnvelope[] {
    const id = String(shape.id ?? "");
    const name = String(shape.name ?? "");
    this.toolNames.set(id, name);

    const out: EventEnvelope[] = [
      this.envelope(
        "tool_started",
        { kind: "claude" },
        { tool_use_id: id, name, input_summary: summarizeToolInput(name, shape.input) },
        nowMs,
      ),
    ];

    // NO `file_changed` here. It used to be derived from the tool CALL, which
    // meant a FAILED write still reported a file as changed — the feed asserted an
    // effect that never happened. It is now emitted from `ToolContext.onFileChanged`,
    // i.e. by the tool that actually wrote, so the event follows the OUTCOME.
    return out;
  }

  // --- Tool outcomes, emitted by the loop after it dispatches a tool ---------

  toolFinished(toolUseId: string, nowMs: number = Date.now()): EventEnvelope {
    return this.envelope(
      "tool_finished",
      { kind: "claude" },
      { tool_use_id: toolUseId, ok: true },
      nowMs,
    );
  }

  toolFailed(toolUseId: string, error: string, nowMs: number = Date.now()): EventEnvelope {
    return this.envelope(
      "tool_failed",
      { kind: "claude" },
      { tool_use_id: toolUseId, ok: false, error },
      nowMs,
    );
  }

  toolRefused(
    toolUseId: string,
    name: string,
    by: string,
    reason: string,
    nowMs: number = Date.now(),
  ): EventEnvelope {
    return this.envelope(
      "tool_refused",
      { kind: "system" },
      { tool_use_id: toolUseId, name, by, reason },
      nowMs,
    );
  }

  /** Bash output in ~64KB chunks, one event per chunk, ascending index. */
  terminalOutput(toolUseId: string, text: string, nowMs: number = Date.now()): EventEnvelope[] {
    const out: EventEnvelope[] = [];
    for (let at = 0, index = 0; at < text.length; at += TERMINAL_CHUNK_BYTES, index += 1) {
      out.push(
        this.envelope(
          "terminal_output",
          { kind: "claude" },
          {
            tool_use_id: toolUseId,
            chunk_index: index,
            text: text.slice(at, at + TERMINAL_CHUNK_BYTES),
          },
          nowMs,
        ),
      );
    }
    return out;
  }

  fileChanged(
    toolUseId: string,
    path: string,
    change: "created" | "modified",
    nowMs: number = Date.now(),
  ): EventEnvelope {
    return this.envelope(
      "file_changed",
      { kind: "claude" },
      { tool_use_id: toolUseId, path, change },
      nowMs,
    );
  }

  // --- Run lifecycle --------------------------------------------------------

  runStarted(payload: Record<string, unknown>, nowMs: number = Date.now()): EventEnvelope {
    return this.envelope("run_started", this.userActor(), payload, nowMs);
  }

  userPrompt(text: string, nowMs: number = Date.now()): EventEnvelope {
    return this.envelope("user_prompt", this.userActor(), { text }, nowMs);
  }

  requestHeader(payload: Record<string, unknown>, nowMs: number = Date.now()): EventEnvelope {
    return this.envelope("request_header", { kind: "system" }, payload, nowMs);
  }

  contextUsage(usage: Usage, window: number, nowMs: number = Date.now()): EventEnvelope {
    return this.envelope(
      "context_usage",
      { kind: "system" },
      {
        input: usage.input_tokens,
        output: usage.output_tokens,
        cache_read: usage.cache_read_input_tokens,
        cache_creation: usage.cache_creation_input_tokens,
        window,
      },
      nowMs,
    );
  }

  providerError(
    payload: { provider: string; kind: string; message: string; remedy: string },
    nowMs: number = Date.now(),
  ): EventEnvelope {
    return this.envelope("provider_error", { kind: "system" }, payload, nowMs);
  }

  recoveryApplied(
    payload: { run_id: string; from_phase: string; action: string; uncertain: boolean },
    nowMs: number = Date.now(),
  ): EventEnvelope {
    return this.envelope("recovery_applied", { kind: "system" }, payload, nowMs);
  }

  runFinished(
    payload: {
      stop_reason: string;
      num_turns: number;
      duration_ms: number;
      total_cost_usd: number;
      usage: unknown;
    },
    nowMs: number = Date.now(),
  ): EventEnvelope {
    return this.envelope("run_finished", { kind: "system" }, payload, nowMs);
  }

  runFailed(
    payload: {
      stop_reason: string;
      api_error_status: string | null;
      total_cost_usd: number;
      usage: unknown;
    },
    nowMs: number = Date.now(),
  ): EventEnvelope {
    return this.envelope("run_failed", { kind: "system" }, payload, nowMs);
  }

  runInterrupted(nowMs: number = Date.now()): EventEnvelope {
    return this.envelope("run_interrupted", this.userActor(), {}, nowMs);
  }

  aiRaw(raw: unknown, nowMs: number = Date.now()): EventEnvelope {
    // Redact FIRST, then truncate to the 8KB cap. Order is load-bearing:
    // truncating first can slice a secret in half and leave the front of it.
    return this.envelope("ai_raw", { kind: "system" }, boundRawPayload(raw), nowMs);
  }

  private accumulate(index: number, kind: BlockAccumulator["kind"], text: string): void {
    const existing = this.blocks.get(index);
    if (existing) existing.text += text;
    else this.blocks.set(index, { kind, text, partialJson: "" });
  }

  private envelope(
    type: EnvelopeType,
    actor: Actor,
    payload: unknown,
    nowMs: number,
  ): EventEnvelope {
    const ephemeral = this.isEphemeral(type);
    return {
      id: null,
      session_id: this.ctx.sessionId,
      // Session-scoped types are not produced here; everything the loop emits is
      // run-scoped.
      ai_run_id: this.ctx.aiRunId,
      seq: ephemeral ? null : ++this.seq,
      type,
      actor,
      ts: isoMs(nowMs),
      payload,
    };
  }

  private userActor(): Actor {
    return this.ctx.requestedBy ? { kind: "user", id: this.ctx.requestedBy } : { kind: "system" };
  }
}

function inferKind(shape: Record<string, unknown>): BlockAccumulator["kind"] {
  const type = String(shape.type ?? "");
  if (type === "text") return "text";
  if (type === "thinking" || type === "redacted_thinking") return "thinking";
  if (type.startsWith("compaction")) return "compaction";
  return "tool_use";
}

function firstNonEmpty(...candidates: string[]): string {
  return candidates.find((c) => c.length > 0) ?? "";
}
