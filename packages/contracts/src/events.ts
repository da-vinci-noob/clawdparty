/**
 * clawdparty event contract — the machine-checked source of truth for the
 * event envelope and the frozen 20-name type taxonomy.
 *
 * Prose, rationale, and the per-type payload tables live in
 * `docs/contracts/events.md`; this file is the typed shape that `sidecar/` and
 * `web/` import. When the two disagree: this file is authoritative for SHAPE,
 * the doc is authoritative for INTENT — keep them in sync and record every
 * change in `docs/contracts/CHANGELOG.md`.
 *
 * FREEZE STATE (Week 1): the envelope fields, their scalar types, the 20 type
 * names, and the `Actor` union are FROZEN. Per-type `payload` interfaces are
 * `pending-spike` — typed `unknown` until the Tuesday SDK spike output is
 * incorporated at the Wednesday freeze. Do not narrow them by guessing.
 */

/**
 * Contract version. `minor` bumps on an additive CHANGELOG entry (a new event
 * type, a new optional field); `major` bumps — resetting `minor` to 0 — on a
 * breaking entry (an envelope or endpoint-signature change). A consumer asserts
 * compatibility by requiring an EXACT `major` and a `minor` >= what it needs, so
 * a breaking `major` bump fails the check rather than passing a loose `>=`.
 */
export const CONTRACT_VERSION = { major: 1, minor: 0 } as const;

/**
 * The 20 frozen event type names. Adding or removing a name is a CONTRACT
 * CHANGE (see `docs/contracts/CHANGELOG.md`). Order is for readability only;
 * clients order events by `id`/`seq`, never by position here.
 */
export const EVENT_TYPES = [
  "run_started",
  "ai_text_delta",
  "ai_text",
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

/** One of the 20 frozen taxonomy names. */
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * The `ai_raw` fallback: any SDK message the normalizer cannot map to a known
 * type is emitted as `ai_raw` rather than dropped or crashing. It is NOT a
 * member of the 20-name taxonomy.
 */
export const AI_RAW = "ai_raw" as const;

/** Any value the `type` field may hold: the 20 names plus the `ai_raw` fallback. */
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
 * - `type`       one of the 20 names, or `ai_raw`.
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
 * PENDING-SPIKE placeholder. Every per-type payload below is typed as `unknown`
 * until the Tuesday SDK spike output is incorporated at the Wednesday freeze.
 * They are listed EXPLICITLY (never omitted) so the set of types still needing
 * a payload schema is visible. The `ai_text_delta` `block` field — the key the
 * web reducer accumulates deltas by, per the `(ai_run_id, block)` rule — is
 * itself `pending-spike` and resolved from spike output.
 */
type PendingSpikePayload = unknown;

/**
 * Maps every envelope type to its payload. Keys MUST equal the taxonomy (the 20
 * names + `ai_raw`) exactly — enforced by `PAYLOAD_MAP_COVERS_TAXONOMY` below.
 */
export interface EventPayloadMap {
  run_started: PendingSpikePayload;
  ai_text_delta: PendingSpikePayload;
  ai_text: PendingSpikePayload;
  ai_thinking: PendingSpikePayload;
  tool_started: PendingSpikePayload;
  tool_finished: PendingSpikePayload;
  tool_failed: PendingSpikePayload;
  terminal_output: PendingSpikePayload;
  file_changed: PendingSpikePayload;
  run_finished: PendingSpikePayload;
  run_failed: PendingSpikePayload;
  run_interrupted: PendingSpikePayload;
  changeset_ready: PendingSpikePayload;
  changeset_approved: PendingSpikePayload;
  changeset_rejected: PendingSpikePayload;
  chat_message: PendingSpikePayload;
  task_created: PendingSpikePayload;
  task_updated: PendingSpikePayload;
  participant_joined: PendingSpikePayload;
  presence_changed: PendingSpikePayload;
  ai_raw: PendingSpikePayload;
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
 * Guard: the taxonomy holds EXACTLY 20 names. If `EVENT_TYPES` drifts from 20
 * entries without a contract change, this assignment stops type-checking.
 */
export const EVENT_TYPE_COUNT: 20 = EVENT_TYPES.length;

/**
 * Guard: `EventPayloadMap` covers exactly the envelope taxonomy (the 20 names +
 * `ai_raw`) — no missing key, no stray key. If they diverge, this assignment's
 * type becomes `false` and `true` no longer satisfies it.
 */
export const PAYLOAD_MAP_COVERS_TAXONOMY: Equal<keyof EventPayloadMap, EnvelopeType> = true;
