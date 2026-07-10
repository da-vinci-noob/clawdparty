/**
 * clawdparty event contract — the machine-checked source of truth for the
 * event envelope and the frozen 22-name type taxonomy.
 *
 * Prose, rationale, and the per-type payload tables live in
 * `docs/contracts/events.md`; this file is the typed shape that `sidecar/` and
 * `web/` import. When the two disagree: this file is authoritative for SHAPE,
 * the doc is authoritative for INTENT — keep them in sync and record every
 * change in `docs/contracts/CHANGELOG.md`.
 *
 * FREEZE STATE: the envelope fields, their scalar types, the 22 type names, and
 * the `Actor` union are FROZEN (since v1.0). Per-type `payload` interfaces were
 * FINALIZED from the real SDK spike at v1.1 (`sdk-message-spike`); they are no
 * longer `pending-spike`. See `docs/contracts/sdk_mapping.md` for the derivation.
 */

/**
 * Contract version. `minor` bumps on an additive CHANGELOG entry (a new event
 * type, a new optional field); `major` bumps — resetting `minor` to 0 — on a
 * breaking entry (an envelope or endpoint-signature change). A consumer asserts
 * compatibility by requiring an EXACT `major` and a `minor` >= what it needs, so
 * a breaking `major` bump fails the check rather than passing a loose `>=`.
 */
export const CONTRACT_VERSION = { major: 1, minor: 3 } as const;

/**
 * The 22 frozen event type names. Adding or removing a name is a CONTRACT
 * CHANGE (see `docs/contracts/CHANGELOG.md`). Order is for readability only;
 * clients order events by `id`/`seq`, never by position here.
 */
export const EVENT_TYPES = [
  "run_started",
  "user_prompt",
  "ai_text_delta",
  "ai_text",
  "ai_thinking_delta",
  "ai_thinking",
  "tool_started",
  "tool_finished",
  "tool_failed",
  "terminal_output",
  "file_changed",
  "run_finished",
  "run_failed",
  "run_interrupted",
  "changeset_ready",
  "changeset_approved",
  "changeset_rejected",
  "chat_message",
  "task_created",
  "task_updated",
  "participant_joined",
  "presence_changed",
] as const;

/** One of the 22 frozen taxonomy names. */
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * The `ai_raw` fallback: any SDK message the normalizer cannot map to a known
 * type is emitted as `ai_raw` rather than dropped or crashing. It is NOT a
 * member of the 22-name taxonomy.
 */
export const AI_RAW = "ai_raw" as const;

/** Any value the `type` field may hold: the 22 names plus the `ai_raw` fallback. */
export type EnvelopeType = EventType | typeof AI_RAW;

/**
 * Event actor — a discriminated union on `kind`. `id` is present IF AND ONLY IF
 * `kind === "user"`, and is the originating participant's id (NOT a display
 * name — resolved client-side — and NOT a role — resolved/enforced server-side).
 */
export type Actor = { kind: "claude" } | { kind: "user"; id: string } | { kind: "system" };

/**
 * The canonical event envelope. Every live occurrence in a session is exactly
 * one of these. A consumer that does not recognize `type` can still read every
 * envelope field and treat `payload` as opaque JSON.
 *
 * Scalar types are FROZEN (not spike-gated; only `payload` internals are):
 * - `id`         integer global cursor for DURABLE events; `null` for EPHEMERAL
 *                events (`ai_text_delta`, `presence_changed`) — broadcast,
 *                never persisted, so they carry no cursor.
 * - `session_id` present on every event.
 * - `ai_run_id`  present for run-scoped events; `null` for session-scoped events.
 * - `seq`        per-run monotonic integer for DURABLE run-scoped events;
 *                `null` for ephemeral and for session-scoped events.
 * - `type`       one of the 22 names, or `ai_raw`.
 * - `actor`      see `Actor`.
 * - `ts`         ISO-8601 UTC, millisecond precision, `Z` suffix
 *                (e.g. `2026-06-28T20:11:05.123Z`). DISPLAY-ONLY: order by `id`
 *                across the session and by `seq` within a run, never by `ts`.
 * - `payload`    type-specific JSON; internals are `pending-spike`.
 */
export interface EventEnvelope<P = unknown> {
  id: number | null;
  session_id: string;
  ai_run_id: string | null;
  seq: number | null;
  type: EnvelopeType;
  actor: Actor;
  ts: string;
  payload: P;
}

/**
 * Per-type payload schemas, FINALIZED from the real SDK spike (`sdk-message-spike`;
 * see `docs/contracts/sdk_mapping.md` for the derivation from `raw_run.jsonl`).
 * SDK-produced types are derived from captured message shapes; Rails-originated
 * types (`chat_message`, `participant_joined`, `presence_changed`, `changeset_*`,
 * `task_*`) are defined from the data model (they were never SDK-gated). This
 * replaces the v1.0 `pending-spike` `unknown` stubs — an additive `minor` bump.
 */

/** Token usage carried on run-completion events (trimmed from the SDK `usage`). */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface RunStartedPayload {
  model: string;
  cwd: string;
  permission_mode: string;
  claude_session_id: string;
}
/** The human's prompt that drives a run — the initial prompt and each follow-up.
 *  Run-scoped + durable; emitted by the sidecar (it owns the per-run seq space).
 *  Attribution is on the envelope `actor` ({ kind: "user", id }), not the payload. */
export interface UserPromptPayload {
  text: string;
}
/** `block` = "<assistant_message_uuid>:<content_block_index>" — the reducer accumulation key. */
export interface AiTextDeltaPayload {
  block: string;
  text: string;
}
export interface AiTextPayload {
  block: string;
  text: string;
}
/** Ephemeral thinking delta (streamed live), keyed by the same "<uuid>:<index>"
 *  block key as the durable `ai_thinking`, so the live accumulator reconciles. */
export interface AiThinkingDeltaPayload {
  block: string;
  text: string;
}
export interface AiThinkingPayload {
  block: string;
  text: string;
}
/** `input_summary` is the summarized tool input (≤~500 chars), NEVER the full Edit/Write content. */
export interface ToolStartedPayload {
  tool_use_id: string;
  name: string;
  input_summary: string;
}
export interface ToolFinishedPayload {
  tool_use_id: string;
  ok: true;
}
export interface ToolFailedPayload {
  tool_use_id: string;
  ok: false;
  error: string;
}
/** Bash output emitted in ~64KB chunks (one event per chunk, ascending index). */
export interface TerminalOutputPayload {
  tool_use_id: string;
  chunk_index: number;
  text: string;
}
export interface FileChangedPayload {
  tool_use_id: string;
  path: string;
  change: "created" | "modified";
}
export interface RunFinishedPayload {
  stop_reason: string;
  num_turns: number;
  duration_ms: number;
  total_cost_usd: number;
  usage: TokenUsage;
}
export interface RunFailedPayload {
  stop_reason: string;
  api_error_status: string | null;
  total_cost_usd: number;
  usage: TokenUsage;
}
export type RunInterruptedPayload = Record<string, never>;
export interface ChangesetReadyPayload {
  files_changed: number;
  insertions: number;
  deletions: number;
}
export interface ChangesetApprovedPayload {
  commit_sha: string;
}
export type ChangesetRejectedPayload = Record<string, never>;
export interface ChatMessagePayload {
  body: string;
}
export interface TaskPayload {
  task_id: string;
  title: string;
  status: string;
}
export interface ParticipantJoinedPayload {
  participant_id: string;
  name: string;
  role: string;
}
export interface PresenceChangedPayload {
  participant_id: string;
  online: boolean;
}
/** The never-crash fallback: redacted-then-truncated (≤8KB) opaque content. */
export interface AiRawPayload {
  raw: unknown;
  truncated: boolean;
}

/**
 * Maps every envelope type to its payload. Keys MUST equal the taxonomy (the 20
 * names + `ai_raw`) exactly — enforced by `PAYLOAD_MAP_COVERS_TAXONOMY` below.
 */
export interface EventPayloadMap {
  run_started: RunStartedPayload;
  user_prompt: UserPromptPayload;
  ai_text_delta: AiTextDeltaPayload;
  ai_text: AiTextPayload;
  ai_thinking_delta: AiThinkingDeltaPayload;
  ai_thinking: AiThinkingPayload;
  tool_started: ToolStartedPayload;
  tool_finished: ToolFinishedPayload;
  tool_failed: ToolFailedPayload;
  terminal_output: TerminalOutputPayload;
  file_changed: FileChangedPayload;
  run_finished: RunFinishedPayload;
  run_failed: RunFailedPayload;
  run_interrupted: RunInterruptedPayload;
  changeset_ready: ChangesetReadyPayload;
  changeset_approved: ChangesetApprovedPayload;
  changeset_rejected: ChangesetRejectedPayload;
  chat_message: ChatMessagePayload;
  task_created: TaskPayload;
  task_updated: TaskPayload;
  participant_joined: ParticipantJoinedPayload;
  presence_changed: PresenceChangedPayload;
  ai_raw: AiRawPayload;
}

/**
 * A fully-typed event for a known `type`. Once the spike replaces the
 * `PendingSpikePayload` stubs with concrete interfaces, this becomes a precise
 * discriminated union the reducer can switch on exhaustively.
 */
export type AnyEvent = {
  [K in keyof EventPayloadMap]: EventEnvelope<EventPayloadMap[K]> & { type: K };
}[keyof EventPayloadMap];

// --- Compile-time freeze guards (exported so they are never "unused"). --------

type Extends<A, B> = [A] extends [B] ? true : false;
type Equal<A, B> = Extends<A, B> extends true ? (Extends<B, A> extends true ? true : false) : false;

/**
 * Guard: the taxonomy holds EXACTLY 22 names. If `EVENT_TYPES` drifts from 22
 * entries without a contract change, this assignment stops type-checking.
 */
export const EVENT_TYPE_COUNT: 22 = EVENT_TYPES.length;

/**
 * Guard: `EventPayloadMap` covers exactly the envelope taxonomy (the 22 names +
 * `ai_raw`) — no missing key, no stray key. If they diverge, this assignment's
 * type becomes `false` and `true` no longer satisfies it.
 */
export const PAYLOAD_MAP_COVERS_TAXONOMY: Equal<keyof EventPayloadMap, EnvelopeType> = true;
