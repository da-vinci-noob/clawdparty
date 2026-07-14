// normalizer.ts — the ONLY sidecar file that touches raw @anthropic-ai/claude-
// agent-sdk message shapes. Every other file (index/transport/permissions) sees
// only Contract-1 envelopes. This contains SDK shape/version surprises here.
//
// v1 committed behavior (pre-spike):
//  - never-crash: any unknown/unmapped/malformed SDK message -> `ai_raw`, never
//    dropped, never thrown.
//  - `ai_raw` payload is REDACTED then TRUNCATED (8KB) — order matters.
//  - per-run monotonic `seq`, scoped to ai_run_id, assigned ONLY to durable
//    run-scoped events; ephemeral events carry null seq + null id.
//  - actor stamping: run_started / run_interrupted -> { kind:"user", id:requested_by };
//    Claude-originated -> { kind:"claude" }.
// The full per-SDK-type mapping table is `pending-spike` (see PENDING_SPIKE).

import type { Actor, EnvelopeType, EventEnvelope } from "@clawdparty/contracts";

const EPHEMERAL_TYPES = new Set<EnvelopeType>(["ai_text_delta", "presence_changed"]);

export const AI_RAW_CAP_BYTES = 8 * 1024;

// Case-insensitive key-name match for credential-bearing fields. Matches more
// than the four obvious names (also pwd, credential, private_key, aws_*_key…).
const CREDENTIAL_KEY =
  /(api[_-]?key|token|secret|authorization|bearer|password|passwd|pwd|credential|private[_-]?key|aws[_-]?(secret|access)[_-]?key)/i;
const REDACTED = "[REDACTED]";

// PENDING-SPIKE: the full per-SDK-message-type mapping (text deltas, text blocks,
// thinking, tool start/finish/fail, terminal output, file changes, run lifecycle,
// result incl. cost/usage; tool-input summarization to ~500 chars; terminal_output
// ~64KB chunking) is finalized only after the Tuesday SDK spike. Do NOT invent it
// from guessed shapes here. Only the never-crash unknown->ai_raw behavior and the
// ephemeral classification are committed in v1.
export const PENDING_SPIKE = {
  perTypeMapping: "pending-spike",
  costUsageOnResult: "pending-spike",
  toolInputSummarization: "pending-spike",
  terminalOutputChunking: "pending-spike",
} as const;

export interface NormalizeContext {
  sessionId: string;
  aiRunId: string;
  // The originating participant id for run_started / run_interrupted attribution.
  requestedBy?: string;
}

// Recursively redact credential-bearing values by key name, across the full
// structure. Returns a structurally-cloned, redacted copy (never mutates input).
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

// Redact FIRST, then truncate to the 8KB cap. Redacting before truncating ensures
// a credential is never leaked by the cap boundary slicing through a key/value
// pair after the redactor stopped scanning.
export function boundRawPayload(raw: unknown): { raw: unknown; truncated: boolean } {
  const redacted = redactCredentials(raw);
  const serialized = JSON.stringify(redacted) ?? "";
  if (Buffer.byteLength(serialized, "utf8") <= AI_RAW_CAP_BYTES) {
    return { raw: redacted, truncated: false };
  }
  const sliced = Buffer.from(serialized, "utf8").subarray(0, AI_RAW_CAP_BYTES).toString("utf8");
  return { raw: { truncated_serialized: sliced }, truncated: true };
}

function isoMs(date: Date): string {
  return `${date.toISOString().slice(0, 23)}Z`;
}

// The sidecar assigns per-run monotonic `seq` to DURABLE run-scoped events only.
// Rails assigns the global `id` on ingest, so the sidecar always emits id: null.
export class Normalizer {
  private seq = 0;

  constructor(private readonly ctx: NormalizeContext) {}

  isEphemeral(type: EnvelopeType): boolean {
    return EPHEMERAL_TYPES.has(type);
  }

  // Build a Contract-1 envelope. Ephemeral types get null seq; durable run-scoped
  // types consume the next per-run seq. `id` is always null (Rails assigns it).
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

  // v1 fallback: degrade any unknown/unmapped/malformed SDK message to `ai_raw`,
  // never throwing. Redact-then-truncate the payload. `ai_raw` is durable.
  toAiRaw(rawMessage: unknown, nowMs: number): EventEnvelope {
    let bounded: { raw: unknown; truncated: boolean };
    try {
      bounded = boundRawPayload(rawMessage);
    } catch {
      // Even a serialization failure must not throw — emit a minimal ai_raw.
      bounded = { raw: { unserializable: true }, truncated: false };
    }
    return this.envelope("ai_raw", { kind: "system" }, bounded, nowMs);
  }

  // run_started is user-attributed via requested_by.
  runStarted(nowMs: number): EventEnvelope {
    return this.envelope("run_started", this.userActor(), {}, nowMs);
  }

  // run_interrupted mirrors run_started — user-attributed via requested_by,
  // NOT system-attributed.
  runInterrupted(nowMs: number): EventEnvelope {
    return this.envelope("run_interrupted", this.userActor(), {}, nowMs);
  }

  private userActor(): Actor {
    if (!this.ctx.requestedBy) {
      throw new Error("requestedBy is required to stamp a user actor");
    }
    return { kind: "user", id: this.ctx.requestedBy };
  }
}
