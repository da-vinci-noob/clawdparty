/**
 * clawdparty event contract — the machine-checked source of truth for the
 * event envelope and the frozen 30-name type taxonomy.
 *
 * Prose, rationale, and the per-type payload tables live in
 * `docs/contracts/events.md`; this file is the typed shape that `harness/` and
 * `web/` import. When the two disagree: this file is authoritative for SHAPE,
 * the doc is authoritative for INTENT — keep them in sync and record every
 * change in `docs/contracts/CHANGELOG.md`.
 *
 * FREEZE STATE: the envelope fields, their scalar types, and the `Actor` union
 * are FROZEN (since v1.0). Per-type `payload` interfaces were FINALIZED from the
 * real SDK spike at v1.1 (`sdk-message-spike`). The taxonomy has grown additively
 * — 20 at v1.0, 21 at v1.2, 22 at v1.3, 30 at v1.5 (the harness types) — and each
 * growth is a CHANGELOG entry with a `minor` bump.
 */

/**
 * Contract version. `minor` bumps on an additive CHANGELOG entry (a new event
 * type, a new optional field); `major` bumps — resetting `minor` to 0 — on a
 * breaking entry (an envelope or endpoint-signature change). A consumer asserts
 * compatibility by requiring an EXACT `major` and a `minor` >= what it needs, so
 * a breaking `major` bump fails the check rather than passing a loose `>=`.
 */
export const CONTRACT_VERSION = { major: 1, minor: 7 } as const;

/**
 * The 30 frozen event type names. Adding or removing a name is a CONTRACT
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
  // --- Harness types, added at v1.5 (001-sidecar-harness-architecture) --------
  "request_header",
  "context_compacted",
  "context_usage",
  "tool_refused",
  "plugin_enabled",
  "plugin_disabled",
  "provider_error",
  "recovery_applied",
] as const;

/** One of the 30 frozen taxonomy names. */
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * The `ai_raw` fallback: any provider message the normalizer cannot map to a
 * known type is emitted as `ai_raw` rather than dropped or crashing. It is NOT a
 * member of the 30-name taxonomy.
 */
export const AI_RAW = "ai_raw" as const;

/** Any value the `type` field may hold: the 30 names plus the `ai_raw` fallback. */
export type EnvelopeType = EventType | typeof AI_RAW;

/**
 * The EPHEMERAL types: broadcast to subscribers but NEVER persisted. They carry
 * a null `id` (the marker of ephemerality) and a null `seq` — they never consume
 * a per-run sequence number.
 *
 * Exported as data because three streams need the same answer and each had been
 * deriving it separately: the harness decides what not to send `store_seq` for,
 * Rails' `Event::EPHEMERAL_TYPES` decides what not to persist, and the web store
 * decides what not to dedupe by `id`. A type missing from one of those three
 * lists is a silent bug — `context_usage` absent from the Rails list would be
 * persisted and handed a durable `id`.
 */
export const EPHEMERAL_EVENT_TYPES = [
  "ai_text_delta",
  "ai_thinking_delta",
  "presence_changed",
  "context_usage",
] as const;

export type EphemeralEventType = (typeof EPHEMERAL_EVENT_TYPES)[number];

/**
 * Types the harness SYNTHESIZES — they map from no provider message at all. The
 * harness's own decisions (what it sent, refused, recovered, compacted) plus the
 * human's prompt, which the harness records because it owns the per-run `seq`
 * space.
 *
 * Load-bearing for the normalizer cross-check: that test asserts the ordered
 * type sequence produced by replaying a captured provider transcript equals the
 * fixture's durable run-scoped sequence. Synthesized types appear in the fixture
 * and can never appear in a capture, so they must be excluded EXPLICITLY. It
 * previously worked by coincidence — "durable and run-scoped" happened to select
 * only mapped types because the fixture contained no synthesized ones.
 */
export const SYNTHESIZED_EVENT_TYPES = [
  "user_prompt",
  "request_header",
  "context_compacted",
  "context_usage",
  "tool_refused",
  "plugin_enabled",
  "plugin_disabled",
  "provider_error",
  "recovery_applied",
] as const;

export type SynthesizedEventType = (typeof SYNTHESIZED_EVENT_TYPES)[number];

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
 *                events (see `EPHEMERAL_EVENT_TYPES`) — broadcast, never
 *                persisted, so they carry no cursor.
 * - `session_id` present on every event.
 * - `ai_run_id`  present for run-scoped events; `null` for session-scoped events.
 * - `seq`        per-run monotonic integer for DURABLE run-scoped events;
 *                `null` for ephemeral and for session-scoped events.
 * - `type`       one of the 30 names, or `ai_raw`.
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
  /**
   * The harness store's session-wide cursor for this event (v1.5, additive and
   * OPTIONAL — the envelope's frozen fields are untouched).
   *
   * Present on durable events shipped by the harness; absent on ephemeral ones,
   * which were never persisted and so have no cursor. It exists so Rails can
   * re-derive the projection from `entriesFrom(store_seq)` after an outage
   * — which is what makes a ring-buffer overflow degrade the live stream
   * without losing the record.
   *
   * Clients still page on `id`. This is a projection-repair cursor, not a second
   * client cursor, and treating it as one would reintroduce the dual-cursor
   * confusion `id`/`seq` already resolves.
   */
  store_seq?: number;
}

/**
 * Per-type payload schemas, FINALIZED from the real SDK spike (`sdk-message-spike`;
 * see `docs/contracts/provider_event_mapping.md` for the derivation from `raw_run.jsonl`).
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
  /** The capabilities the run actually applied (additive since v1.4), echoed so
   *  the UI — including late joiners via backfill — reflects a run's real scope.
   *  Omitted means "today's defaults" (nothing disabled / no connectors / no
   *  skills). These are the RESOLVED values, not the raw request. */
  disallowed_tools?: string[];
  connectors?: string[];
  skills?: string[];
}

// --- Run capability selection (additive since v1.4) --------------------------
// Shared shapes for the per-run tool/connector/skill surface. Tools are a FIXED
// constant (they never vary by host/repo); connectors + skills are discovered
// per session by the harness and proxied by Rails.

export interface ToolInfo {
  id: string;
  label: string;
  description: string;
}

export interface ConnectorInfo {
  name: string;
  /** Transport kind only — never the server's command/url/headers/env/tokens. */
  transport: string;
}

export interface SkillInfo {
  name: string;
  description: string;
}

/** The canonical built-in tools offered in the picker (all default-ON). The web
 *  picker and Rails validation both read this — there is no /api/tools endpoint.
 *  Turning one OFF sends it in `disallowed_tools`, which the harness maps to the
 *  SDK `disallowedTools` (a bare name genuinely removes the tool, even under
 *  bypassPermissions — `allowedTools` only pre-approves). */
export const BUILTIN_TOOLS: readonly ToolInfo[] = [
  { id: "Read", label: "Read", description: "Read files" },
  { id: "Write", label: "Write", description: "Create & overwrite files" },
  { id: "Edit", label: "Edit", description: "Edit files in place" },
  { id: "Bash", label: "Bash", description: "Run shell commands" },
  { id: "Glob", label: "Glob", description: "Find files by pattern" },
  { id: "Grep", label: "Grep", description: "Search file contents" },
  { id: "WebSearch", label: "WebSearch", description: "Search the web" },
  { id: "WebFetch", label: "WebFetch", description: "Fetch & read web pages" },
] as const;

/** The bare tool ids, for validating a `disallowed_tools` selection. */
export const BUILTIN_TOOL_IDS: readonly string[] = BUILTIN_TOOLS.map((t) => t.id);
/** The human's prompt that drives a run — the initial prompt and each follow-up.
 *  Run-scoped + durable; emitted by the harness (it owns the per-run seq space).
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
  /**
   * `null` when no price was computed — UNKNOWN, which is not the same as free.
   *
   * Nullable since v1.7: the harness sent a hardcoded `0`, and once Rails began copying the
   * figure onto `ai_runs.total_cost_usd` every run would have recorded a cost of exactly zero.
   * No provider here reports a price (Bedrock does not, and the harness computes none), so `0`
   * was a false claim about a request that was actually made. Same rule the usage ledger
   * already follows: no report means no row, never zeros.
   */
  total_cost_usd: number | null;
  usage: TokenUsage;
}
export interface RunFailedPayload {
  stop_reason: string;
  api_error_status: string | null;
  /** `null` when no price was computed — see `RunFinishedPayload.total_cost_usd`. */
  total_cost_usd: number | null;
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

// --- Harness payloads (added v1.5) ------------------------------------------
// The harness owns the loop, so its own decisions become visible in the same
// stream as the model's output. Every one of these is emitted by the harness;
// none maps to a vendor SDK message.

/**
 * What was actually sent to the provider, recorded BEFORE the request goes out
 *. Digests, not contents: the system prompt and tool schemas
 * can be large and are reconstructible from the record, so this carries a hash
 * to prove which version was used without duplicating it into every run.
 *
 * `credential_source` is a source IDENTITY (`CredentialSourceId`), never a value.
 * That distinction is the whole point of the field — it makes "which login did
 * this run use?" answerable without a credential ever entering the record.
 */
export interface RequestHeaderPayload {
  provider: string;
  credential_source: CredentialSourceId;
  model: string;
  effort: EffortLevel | null;
  system_prompt_digest: string;
  tool_schemas_digest: string;
  plugins: string[];
}

/**
 * A span of the record was replaced by a compaction block. The
 * replaced range is named by `seq` so the projection can show what collapsed;
 * `summary_present` is false when the provider compacted without returning a
 * summary block, which is a real case and must not be reported as a summary.
 */
export interface ContextCompactedPayload {
  replaced_from_seq: number;
  replaced_to_seq: number;
  tokens_before: number;
  summary_present: boolean;
}

/**
 * Live context pressure. EPHEMERAL — the durable per-run figure lives
 * on `run_finished`/`run_failed`. `window` is the REAL budget for the model in
 * use, read from the adapter's `capabilities()`, never a hardcoded constant.
 */
export interface ContextUsagePayload {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  window: number;
}

/**
 * A tool call was refused before executing. `by` names what refused —
 * a policy, a plugin id, or a participant — so a refusal is attributable rather
 * than appearing as an unexplained gap in the run.
 */
export interface ToolRefusedPayload {
  tool_use_id: string;
  name: string;
  by: string;
  reason: string;
}

/** Plugin lifecycle. Session-scoped: enabling is a property of the room. */
export interface PluginTogglePayload {
  id: string;
  version: string;
  origin: "builtin" | "third_party";
  by: string;
}

/**
 * A provider request failed. `remedy` is REQUIRED and must be
 * actionable — the requirement is that a broken credential names itself and the
 * fix, so a generic message here is a contract violation, not a lazy string.
 */
export interface ProviderErrorPayload {
  provider: string;
  kind:
    | "no_credential"
    | "credential_expired"
    | "not_entitled"
    | "region_unset"
    | "unreachable"
    | "api_error";
  message: string;
  remedy: string;
}

/**
 * Recovery ran after a crash. `uncertain: true` is the load-bearing
 * value: when the harness died between dispatching a request and recording its
 * outcome, the fate is genuinely unknown, and /AC4 requires the feed to SAY
 * so rather than implying either outcome. Never default it to false to make a
 * display simpler.
 */
export interface RecoveryAppliedPayload {
  run_id: string;
  from_phase: string;
  action: "resumed" | "replayed" | "abandoned" | "failed";
  uncertain: boolean;
}

/**
 * Maps every envelope type to its payload. Keys MUST equal the taxonomy (the 30
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
  request_header: RequestHeaderPayload;
  context_compacted: ContextCompactedPayload;
  context_usage: ContextUsagePayload;
  tool_refused: ToolRefusedPayload;
  plugin_enabled: PluginTogglePayload;
  plugin_disabled: PluginTogglePayload;
  provider_error: ProviderErrorPayload;
  recovery_applied: RecoveryAppliedPayload;
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
 * Guard: the taxonomy holds EXACTLY 30 names. If `EVENT_TYPES` drifts from 30
 * entries without a contract change, this assignment stops type-checking.
 *
 * 30, not 29: `harness_http.md` lists the v1.5 additions in seven table rows
 * because `plugin_enabled` and `plugin_disabled` share one. Eight names.
 */
export const EVENT_TYPE_COUNT: 30 = EVENT_TYPES.length;

/**
 * Guard: `EventPayloadMap` covers exactly the envelope taxonomy (the 30 names +
 * `ai_raw`) — no missing key, no stray key. If they diverge, this assignment's
 * type becomes `false` and `true` no longer satisfies it.
 */
export const PAYLOAD_MAP_COVERS_TAXONOMY: Equal<keyof EventPayloadMap, EnvelopeType> = true;

/** Guard: every ephemeral name is a real taxonomy name (catches a typo'd entry). */
export const EPHEMERAL_TYPES_ARE_TAXONOMY: Extends<EphemeralEventType, EventType> = true;

/** Guard: every synthesized name is a real taxonomy name. */
export const SYNTHESIZED_TYPES_ARE_TAXONOMY: Extends<SynthesizedEventType, EventType> = true;

// --- Provider vocabulary, shared by api/ + harness/ + web/ (v1.5) ------------
// One capability vocabulary across all three streams. `harness/src/providers/
// contract.ts` ALIASES `ProviderCapabilities` rather than redeclaring it — two
// definitions of "what a provider supports" is how the streams drift apart.

/**
 * Reasoning effort. Replaces the removed `thinking.budget_tokens`, which returns
 * 400 on current models.
 */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Where a credential was found — an IDENTITY, never a value. Recorded per run
 * so "which login did this use?" is answerable from the record alone.
 *
 * `keychain:*` is reachable only because the harness is a host process (Q6); a
 * container cannot read the macOS Keychain under any mount configuration.
 */
export type CredentialSourceId =
  | "env:ANTHROPIC_API_KEY"
  | "env:ANTHROPIC_AUTH_TOKEN"
  | "env:CLAUDE_CODE_OAUTH_TOKEN"
  | "profile:ANTHROPIC_PROFILE"
  | "profile:active"
  | "env:workload-identity-federation"
  | "profile:default"
  | "file:~/.claude/.credentials.json"
  | "keychain:anthropic-oauth"
  | "file:~/.codex/auth.json"
  | "env:AWS_PROFILE"
  | "file:~/.aws"
  | "none";

/**
 * Credential precedence, FIRST MATCH WINS. Exported as ORDERED data
 * rather than described in prose so the implementation can be asserted against
 * it instead of re-deriving it.
 *
 * The trap this exists to prevent: an EMPTY `ANTHROPIC_API_KEY=""` still wins
 * slot 0 and authenticates with nothing. Discovery must report it as
 * selected-and-invalid, NOT fall through to the next slot — falling through is
 * the silent-wrong-pick this ordering is meant to make impossible.
 */
export const CREDENTIAL_PRECEDENCE: readonly CredentialSourceId[] = [
  "env:ANTHROPIC_API_KEY",
  "env:ANTHROPIC_AUTH_TOKEN",
  "profile:ANTHROPIC_PROFILE",
  "profile:active",
  "env:workload-identity-federation",
  "profile:default",
] as const;

/**
 * What a provider supports for a GIVEN MODEL. Capabilities are declared, never
 * inferred by the caller, and they are NOT uniform across providers — Bedrock
 * has no web search/fetch, no code execution, no Models API, no automatic prompt
 * caching, and no server-side refusal fallback. The loop reads this; it must
 * never special-case a provider id.
 *
 * Every field is REQUIRED: a partial capability object is indistinguishable from
 * "unsupported", and defaulting an unknown to `false` silently disables features
 * while defaulting to `true` sends requests that 400.
 */
export interface ProviderCapabilities {
  streaming: true;
  toolUse: true;
  /**
   * Whether tools may be offered ON A STREAMING request. Both of the literals above stay
   * true when this is false — the model streams, and it uses tools, just not at the same
   * time.
   *
   * Added at v1.6 because the two capabilities are INDEPENDENT on Amazon Bedrock and the
   * contract could not say so: `streaming: true` and `toolUse: true` are literal types, so
   * every provider asserted both unconditionally. Measured against 18 text-capable
   * non-Anthropic Bedrock models, 8 refuse a `toolConfig` on `ConverseStream` with "This
   * model doesn't support tool use in streaming mode" while accepting it on `Converse` —
   * every Llama, plus Mistral Pixtral and both Writer Palmyra models, two of which return a
   * real `tool_use` stop reason on the non-streaming path. It is a transport limit, not a
   * model limitation.
   *
   * Consumers should treat it as the answer to "will live text arrive on a run that has
   * tools enabled". `false` means the host must either choose another model, run without
   * tools, or accept a turn that only appears when it settles.
   */
  toolUseWhileStreaming: boolean;
  /** The REAL budget for this model — what the live context indicator divides by. */
  contextWindow: number;
  maxOutputTokens: number;
  adaptiveThinking: boolean;
  thinkingDisplaySummarized: boolean;
  effortLevels: readonly EffortLevel[];
  promptCaching: boolean;
  /** Model-dependent and NOT monotonic across models — never interpolate it. */
  minCacheablePrefixTokens: number | null;
  serverSideCompaction: boolean;
  contextEditing: boolean;
  serverSideTools: {
    webSearch: boolean;
    webFetch: boolean;
    codeExecution: boolean;
  };
  liveModelDiscovery: boolean;
  serverSideRefusalFallback: boolean;
  midConversationSystemMessages: boolean;
  /** Gates enabling a plugin mid-session (M5). */
  midConversationToolChanges: boolean;
}

/** Why a provider cannot serve requests on this host. */
export type ProviderUnavailableReason =
  | "no_credential"
  | "credential_expired"
  | "not_entitled"
  | "region_unset"
  | "unreachable";

/**
 * One provider's entry in `GET /api/models`. An unavailable provider is
 * REPORTED, never omitted  — omitting it is what produces "the model
 * picker is just empty" with no way to learn why.
 */
export interface ProviderStatus {
  id: string;
  displayName: string;
  available: boolean;
  reason?: ProviderUnavailableReason;
  /** Actionable, and required whenever `available` is false. */
  remedy?: string;
  credentialSource?: CredentialSourceId;
  models: ProviderModelInfo[];
}

export interface ProviderModelInfo {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
}
