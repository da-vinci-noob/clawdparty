// normalizer.ts — the ONLY sidecar file that touches raw @anthropic-ai/claude-
// agent-sdk message shapes. Every other file (index/runner/transport/permissions)
// sees only Contract-1 envelopes. This contains SDK shape/version surprises here.
//
// Committed behavior:
//  - full per-type mapping per docs/contracts/sdk_mapping.md (derived from the
//    real spike capture, sdk-message-spike): system/init -> run_started; assistant
//    text -> ephemeral ai_text_delta + durable ai_text; thinking -> ai_thinking;
//    tool_use -> tool_started (+ file_changed for Write/Edit); tool_result ->
//    tool_finished/tool_failed (+ terminal_output chunks for Bash); result ->
//    run_finished/run_failed (with cost/usage).
//  - never-crash: any unknown/unmapped/malformed SDK message -> ai_raw, never
//    dropped, never thrown; ai_raw payload REDACTED then TRUNCATED (8KB).
//  - per-run monotonic seq, scoped to ai_run_id, on DURABLE run-scoped events
//    only; ephemeral (ai_text_delta) carries null seq + null id.
//  - actor: run_started/run_interrupted -> { kind:"user", id:requested_by };
//    run_finished/run_failed -> { kind:"system" }; Claude-originated -> claude.

import type { Actor, EnvelopeType, EventEnvelope } from "@clawdparty/contracts";

const EPHEMERAL_TYPES = new Set<EnvelopeType>([
  "ai_text_delta",
  "ai_thinking_delta",
  "presence_changed",
]);

export const AI_RAW_CAP_BYTES = 8 * 1024;
export const TOOL_INPUT_SUMMARY_CAP = 500;
export const TERMINAL_CHUNK_BYTES = 64 * 1024;

const CREDENTIAL_KEY =
  /(api[_-]?key|token|secret|authorization|bearer|password|passwd|pwd|credential|private[_-]?key|aws[_-]?(secret|access)[_-]?key)/i;
const REDACTED = "[REDACTED]";

export interface NormalizeContext {
  sessionId: string;
  aiRunId: string;
  // The originating participant id for run_started / run_interrupted attribution.
  requestedBy?: string;
}

// --- redaction + bounding (unchanged from v1; the ai_raw safety valve) --------

export function redactCredentials(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactCredentials(item));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = CREDENTIAL_KEY.test(key) ? REDACTED : redactCredentials(val);
    }
    return out;
  }
  return value;
}

// Redact FIRST, then truncate to the 8KB cap — order is load-bearing.
export function boundRawPayload(raw: unknown): { raw: unknown; truncated: boolean } {
  const redacted = redactCredentials(raw);
  const serialized = JSON.stringify(redacted) ?? "";
  if (Buffer.byteLength(serialized, "utf8") <= AI_RAW_CAP_BYTES) {
    return { raw: redacted, truncated: false };
  }
  const sliced = Buffer.from(serialized, "utf8").subarray(0, AI_RAW_CAP_BYTES).toString("utf8");
  return { raw: { truncated_serialized: sliced }, truncated: true };
}

// Summarize a tool input to path/command/≤500-char form — NEVER the full payload.
export function summarizeToolInput(name: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  let summary: string;
  if (name === "Write" || name === "Edit" || name === "Read") {
    summary = String(obj.file_path ?? "");
  } else if (name === "Bash") {
    const command = String(obj.command ?? "");
    const description = obj.description ? ` — ${String(obj.description)}` : "";
    summary = `${command}${description}`;
  } else {
    summary = JSON.stringify(obj);
  }
  return summary.slice(0, TOOL_INPUT_SUMMARY_CAP);
}

function isoMs(date: Date): string {
  return `${date.toISOString().slice(0, 23)}Z`;
}

// Minimal shapes the normalizer reads off raw SDK messages (the SDK's own types
// are richer; we read only what the mapping needs).
interface RawBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}
// A streaming content-block delta (SDKPartialAssistantMessage.event) — the only
// stream_event we map. `delta.text` for text_delta, `delta.thinking` for thinking_delta.
interface RawStreamEvent {
  type?: string;
  index?: number;
  delta?: { type?: string; text?: string; thinking?: string };
}
interface RawMessage {
  type?: string;
  subtype?: string;
  uuid?: string;
  message?: { content?: RawBlock[] };
  event?: RawStreamEvent; // stream_event (partial assistant message)
  // result fields
  stop_reason?: string;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: Record<string, number>;
  api_error_status?: string | null;
  is_error?: boolean;
  // init fields
  model?: string;
  cwd?: string;
  permissionMode?: string;
  session_id?: string;
}

export class Normalizer {
  private seq = 0;
  // Track tool_use id -> name so a tool_result can be classified (Bash → terminal).
  private readonly toolNames = new Map<string, string>();

  constructor(private readonly ctx: NormalizeContext) {}

  isEphemeral(type: EnvelopeType): boolean {
    return EPHEMERAL_TYPES.has(type);
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
      ai_run_id: this.ctx.aiRunId,
      seq: ephemeral ? null : ++this.seq,
      type,
      actor,
      ts: isoMs(new Date(nowMs)),
      payload,
    };
  }

  // The full per-type mapping: one raw SDK message -> zero or more Contract-1
  // envelopes (an assistant message has multiple content blocks; a Bash result
  // yields chunked terminal_output). Never throws — unknowns -> ai_raw.
  normalize(rawMessage: unknown, nowMs: number = Date.now()): EventEnvelope[] {
    try {
      return this.map(rawMessage as RawMessage, nowMs);
    } catch {
      return [this.toAiRaw(rawMessage, nowMs)];
    }
  }

  private map(msg: RawMessage, nowMs: number): EventEnvelope[] {
    switch (msg.type) {
      case "system":
        return msg.subtype === "init"
          ? [this.runStartedFromInit(msg, nowMs)]
          : [this.toAiRaw(msg, nowMs)];
      case "assistant":
        return this.mapAssistant(msg, nowMs);
      case "user":
        return this.mapUser(msg, nowMs);
      case "result":
        return [this.mapResult(msg, nowMs)];
      case "stream_event":
        return this.mapStreamEvent(msg, nowMs);
      default:
        return [this.toAiRaw(msg, nowMs)];
    }
  }

  // Live streaming: map ONLY content_block_delta (text/thinking); every other
  // stream-event subtype (message_start/stop, content_block_start/stop,
  // message_delta) yields nothing — never ai_raw noise. Block key
  // "<uuid>:<index>" matches the durable ai_text/ai_thinking that settles it.
  private mapStreamEvent(msg: RawMessage, nowMs: number): EventEnvelope[] {
    const ev = msg.event;
    if (!ev || ev.type !== "content_block_delta" || !ev.delta) {
      return [];
    }
    const block = `${msg.uuid ?? "msg"}:${ev.index ?? 0}`;
    if (ev.delta.type === "text_delta") {
      return [this.textDelta(block, ev.delta.text ?? "", nowMs)];
    }
    if (ev.delta.type === "thinking_delta") {
      return [this.thinkingDelta(block, ev.delta.thinking ?? "", nowMs)];
    }
    return [];
  }

  private runStartedFromInit(msg: RawMessage, nowMs: number): EventEnvelope {
    return this.envelope(
      "run_started",
      this.userActor(),
      {
        model: msg.model ?? "",
        cwd: msg.cwd ?? "",
        permission_mode: msg.permissionMode ?? "",
        claude_session_id: msg.session_id ?? "",
      },
      nowMs,
    );
  }

  private mapAssistant(msg: RawMessage, nowMs: number): EventEnvelope[] {
    const out: EventEnvelope[] = [];
    const blocks = msg.message?.content ?? [];
    blocks.forEach((block, index) => {
      const blockKey = `${msg.uuid ?? "msg"}:${index}`;
      if (block.type === "text") {
        // Durable ai_text on block stop. (Live streaming deltas are emitted by the
        // runner's partial-message path; this maps the completed block.)
        out.push(
          this.envelope(
            "ai_text",
            { kind: "claude" },
            { block: blockKey, text: block.text ?? "" },
            nowMs,
          ),
        );
      } else if (block.type === "thinking") {
        out.push(
          this.envelope(
            "ai_thinking",
            { kind: "claude" },
            { block: blockKey, text: block.thinking ?? "" },
            nowMs,
          ),
        );
      } else if (block.type === "tool_use") {
        const id = block.id ?? "";
        const name = block.name ?? "";
        this.toolNames.set(id, name);
        out.push(
          this.envelope(
            "tool_started",
            { kind: "claude" },
            { tool_use_id: id, name, input_summary: summarizeToolInput(name, block.input) },
            nowMs,
          ),
        );
        if (name === "Write" || name === "Edit") {
          const path = String(((block.input ?? {}) as Record<string, unknown>).file_path ?? "");
          out.push(
            this.envelope(
              "file_changed",
              { kind: "claude" },
              { tool_use_id: id, path, change: name === "Write" ? "created" : "modified" },
              nowMs,
            ),
          );
        }
      }
    });
    return out;
  }

  private mapUser(msg: RawMessage, nowMs: number): EventEnvelope[] {
    const out: EventEnvelope[] = [];
    const blocks = msg.message?.content ?? [];
    for (const block of blocks) {
      if (block.type !== "tool_result") {
        continue;
      }
      const id = block.tool_use_id ?? "";
      const name = this.toolNames.get(id);
      const text =
        typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
      if (name === "Bash" && !block.is_error) {
        out.push(...this.chunkTerminal(id, text, nowMs));
      }
      if (block.is_error) {
        out.push(
          this.envelope(
            "tool_failed",
            { kind: "claude" },
            { tool_use_id: id, ok: false, error: text.slice(0, TOOL_INPUT_SUMMARY_CAP) },
            nowMs,
          ),
        );
      } else {
        out.push(
          this.envelope("tool_finished", { kind: "claude" }, { tool_use_id: id, ok: true }, nowMs),
        );
      }
    }
    return out;
  }

  // Bash output in ~64KB chunks (one event per chunk, ascending index).
  private chunkTerminal(toolUseId: string, text: string, nowMs: number): EventEnvelope[] {
    const buf = Buffer.from(text, "utf8");
    const events: EventEnvelope[] = [];
    let offset = 0;
    let chunkIndex = 0;
    do {
      const slice = buf.subarray(offset, offset + TERMINAL_CHUNK_BYTES).toString("utf8");
      events.push(
        this.envelope(
          "terminal_output",
          { kind: "claude" },
          { tool_use_id: toolUseId, chunk_index: chunkIndex, text: slice },
          nowMs,
        ),
      );
      offset += TERMINAL_CHUNK_BYTES;
      chunkIndex += 1;
    } while (offset < buf.length);
    return events;
  }

  private mapResult(msg: RawMessage, nowMs: number): EventEnvelope {
    const usage = msg.usage ?? {};
    const trimmedUsage = {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    };
    if (msg.subtype === "success" && !msg.is_error) {
      return this.envelope(
        "run_finished",
        { kind: "system" },
        {
          stop_reason: msg.stop_reason ?? "",
          num_turns: msg.num_turns ?? 0,
          duration_ms: msg.duration_ms ?? 0,
          total_cost_usd: msg.total_cost_usd ?? 0,
          usage: trimmedUsage,
        },
        nowMs,
      );
    }
    return this.envelope(
      "run_failed",
      { kind: "system" },
      {
        stop_reason: msg.stop_reason ?? "",
        api_error_status: msg.api_error_status ?? null,
        total_cost_usd: msg.total_cost_usd ?? 0,
        usage: trimmedUsage,
      },
      nowMs,
    );
  }

  // Streaming text delta (ephemeral). `block` is the same key the durable ai_text
  // will carry, so the live accumulator reconciles at block stop.
  textDelta(block: string, text: string, nowMs: number = Date.now()): EventEnvelope {
    return this.envelope("ai_text_delta", { kind: "claude" }, { block, text }, nowMs);
  }

  // Streaming thinking delta (ephemeral). Same block-key scheme as textDelta; the
  // durable ai_thinking settles the block.
  thinkingDelta(block: string, text: string, nowMs: number = Date.now()): EventEnvelope {
    return this.envelope("ai_thinking_delta", { kind: "claude" }, { block, text }, nowMs);
  }

  // Fallback: degrade an unknown/malformed SDK message to ai_raw, never throwing.
  toAiRaw(rawMessage: unknown, nowMs: number): EventEnvelope {
    let bounded: { raw: unknown; truncated: boolean };
    try {
      bounded = boundRawPayload(rawMessage);
    } catch {
      bounded = { raw: { unserializable: true }, truncated: false };
    }
    return this.envelope("ai_raw", { kind: "system" }, bounded, nowMs);
  }

  runInterrupted(nowMs: number = Date.now()): EventEnvelope {
    return this.envelope("run_interrupted", this.userActor(), {}, nowMs);
  }

  // The human's prompt (initial or follow-up). NOT an SDK message — the runner
  // synthesizes it before pushing the user message into the SDK input, so it
  // takes the next durable per-run seq (on a fresh run: seq 1, before run_started).
  userPrompt(text: string, nowMs: number = Date.now()): EventEnvelope {
    return this.envelope("user_prompt", this.userActor(), { text }, nowMs);
  }

  // Synthesized run_failed for a run that ERRORED without emitting a result (SDK
  // crash / auth / connection). Without this the run never reaches a terminal
  // state and Rails leaves it "active" forever (every next message 409s). The
  // reason rides `stop_reason`; usage/cost are zero (no result to read them from).
  runFailed(reason: string, nowMs: number = Date.now()): EventEnvelope {
    return this.envelope(
      "run_failed",
      { kind: "system" },
      {
        stop_reason: reason.slice(0, TOOL_INPUT_SUMMARY_CAP),
        api_error_status: null,
        total_cost_usd: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      nowMs,
    );
  }

  private userActor(): Actor {
    if (!this.ctx.requestedBy) {
      throw new Error("requestedBy is required to stamp a user actor");
    }
    return { kind: "user", id: this.ctx.requestedBy };
  }
}
