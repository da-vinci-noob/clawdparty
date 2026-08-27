import type {
  CredentialSourceId,
  EffortLevel,
  ProviderCapabilities,
  ProviderUnavailableReason,
} from "@clawdparty/contracts";

/**
 * The model-provider capability seam — the Service Definition.
 *
 * BINDING RULE (Principle I): this file imports NO vendor package, and no vendor
 * type crosses this interface. Each adapter is the only code that may import its
 * own vendor SDK. If a type from `@anthropic-ai/bedrock-sdk` or `openai` appears
 * in `loop/`, the seam is broken and providers have stopped being interchangeable.
 *
 * `Capabilities` is an ALIAS of the shared `ProviderCapabilities` rather than a
 * second declaration. Two definitions of "what a provider supports" is precisely
 * how api/, harness/, and web/ drift apart.
 */
export type Capabilities = ProviderCapabilities;
export type { CredentialSourceId, EffortLevel, ProviderUnavailableReason };

export interface ProviderAdapter {
  /** e.g. "anthropic-direct" | "anthropic-bedrock" | "anthropic-oauth" | "codex". */
  readonly id: string;
  readonly displayName: string;

  /** Whether this adapter can serve requests on this host, and why not. */
  probe(): Promise<ProbeResult>;

  /** Models this adapter can actually serve, with real budgets. */
  listModels(): Promise<ModelInfo[]>;

  /**
   * What this adapter supports FOR THIS MODEL. Never inferred by the caller
   * — capabilities are not uniform across providers, and the loop
   * must not special-case an adapter id.
   */
  capabilities(model: string): Capabilities;

  /** Stream one turn. The ONLY method that performs a model request. */
  stream(req: ProviderRequest): AsyncIterable<ProviderEvent>;

  /** Entitlement posture — recorded with the adapter, never assumed. */
  readonly entitlement: EntitlementPosture;

  /**
   * What to tell a participant when THIS provider's credential fails mid-run.
   *
   * The loop classifies the HTTP status and the adapter supplies the words, because only the
   * adapter knows which credential it consumes. One hardcoded remedy for every provider sent a
   * developer whose AWS SSO session had expired to run `claude setup-token`, which fixes nothing
   * and is confidently wrong — the same defect already fixed for the discovery path.
   *
   * Optional so a test double need not restate it, and the FALLBACK is deliberately vague rather
   * than vendor-specific: a missing hint should produce non-specific advice, never advice for the
   * wrong credential.
   */
  readonly failureHints?: FailureHints;
}

export interface FailureHints {
  /** 401 — the credential was rejected. */
  expired: string;
  /** 403 — the credential is valid but not permitted here. Re-authenticating fixes nothing. */
  notEntitled: string;
  /**
   * 429 that reported NO limit and NO retry time, so it is probably not usage.
   *
   * Adapter-supplied because the cause is credential-specific and generic advice here was actively
   * wrong: a subscription token gets this when the request does not identify as Claude Code, and
   * the old shared text blamed the account's entitlement — sending the developer to ask a question
   * whose answer was already yes. Optional; without it the caller says only what it measured.
   */
  quotaUnreported?: string;
  /** Anything else. */
  unreachable: string;
}

export type ProbeResult =
  /** `credentialSource` is an IDENTITY. The value never leaves the adapter. */
  | { available: true; credentialSource: CredentialSourceId }
  | { available: false; reason: ProviderUnavailableReason; remedy: string };

/**
 * A discovery failure the ADAPTER has classified.
 *
 * `listModels()` throwing is how an adapter reports "I cannot tell you what I serve", and
 * `listProviders` reports every such throw as `unreachable` with `String(err)` as the remedy.
 * That is right for a network fault and wrong for an expired credential: the participant got
 * `unreachable` plus a stringified AWS exception instead of `credential_expired` plus the
 * command that fixes it, which is precisely what  asks for.
 *
 * Only the adapter can classify — the reason lives in a vendor's error shape, and teaching the
 * provider-agnostic discovery layer to read AWS exception names would put vendor knowledge
 * exactly where the seam exists to keep it out.
 */
export class ProviderDiscoveryError extends Error {
  constructor(
    message: string,
    readonly reason: ProviderUnavailableReason,
    readonly remedy: string,
  ) {
    super(message);
    this.name = "ProviderDiscoveryError";
  }
}

export interface ModelInfo {
  id: string;
  displayName: string;
  capabilities: Capabilities;
}

/**
 * Whether a credential kind may be used by a third-party client under the
 * vendor's terms. Explicitly NOT a guess — `owner_decision_required` is a real,
 * expected value and must stay distinguishable from "no".
 */
export interface EntitlementPosture {
  credentialKind: "api_key" | "cloud_marketplace" | "subscription" | "enterprise_sso";
  thirdPartyClientPermitted: "yes" | "no" | "owner_decision_required";
  note: string;
}

// --- Request ----------------------------------------------------------------

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface NeutralMessage {
  role: "user" | "assistant";
  /** VERBATIM provider content blocks. Never flattened to a string (R6). */
  content: unknown[];
}

export interface ToolSchema {
  name: string;
  /** Absent for canonical schema-less server tools (`bash`, `text_editor`). */
  input_schema?: unknown;
  type?: string;
  description?: string;
}

/**
 * Provider-neutral request, derived by folding a pure function over the record.
 * DEEP-FROZEN before dispatch: mutating a built request must throw, so a request
 * the record cannot explain is impossible to construct by accident.
 *
 * Note what is absent and must stay absent: `temperature`, `top_p` and `top_k`. They are not
 * optional-and-unused here; they have no field at all, so emitting one is a type error rather than
 * a runtime surprise. Measured, and sharper than R10's "they 400": with thinking enabled,
 * `temperature: 0.5` is refused with "`temperature` may only be set to 1 when thinking is enabled",
 * so the field is not merely useless, it is incompatible with the feature this request is built for.
 *
 * `thinking.budget_tokens` USED to be in that list, on R10's reading that it 400s on current models.
 * That is true of some and false of others — measured on Bedrock, `claude-opus-4-7` refuses it
 * ("thinking.type.enabled is not supported for this model") while `claude-sonnet-4-6` accepts it, and
 * five older profiles accept ONLY it. So it is a per-model shape, not a deprecated one.
 */
export interface ProviderRequest {
  model: string;
  /** Covers thinking AND text together — sizing for text alone truncates (R10). */
  maxTokens: number;
  system: SystemBlock[];
  messages: NeutralMessage[];
  tools: ToolSchema[];
  /**
   * The two shapes are a DISCRIMINATED UNION rather than one object with optional members, so the
   * combinations the API refuses cannot be constructed: `budget_tokens` on an adaptive request, or
   * an `enabled` request with no budget, are both type errors instead of 400s.
   */
  thinking?:
    | { type: "adaptive"; display?: "summarized" | "omitted" }
    | { type: "enabled"; budget_tokens: number }
    | { type: "disabled" };
  effort?: EffortLevel;
  compaction?: boolean;
  /** Block indices; ≤4, one per ~15 blocks (R7). */
  cacheBreakpoints: number[];
  /** Live — the one field that is deliberately NOT frozen. */
  signal: AbortSignal;
}

// --- Events -----------------------------------------------------------------

export type ProviderEvent =
  | { t: "message_start"; model: string }
  | {
      t: "block_start";
      index: number;
      kind: "text" | "thinking" | "tool_use" | "compaction";
    }
  | { t: "text_delta"; index: number; text: string }
  | { t: "thinking_delta"; index: number; text: string }
  | { t: "tool_input_delta"; index: number; partialJson: string }
  /**
   * `block` is the VERBATIM provider block. Load-bearing: compaction and
   * thinking blocks must be stored and echoed back unmodified (R6). An adapter
   * that reconstructs a block rather than passing it through fails conformance.
   */
  | { t: "block_stop"; index: number; block: unknown }
  | { t: "message_delta"; stopReason: StopReason; usage: Usage }
  | { t: "message_stop" }
  /** Never crash on an unknown shape. */
  | { t: "raw"; value: unknown };

/**
 * All six. Two are easy to mishandle and both are silent when mishandled:
 * `pause_turn` must be RESUMED (treating it as terminal truncates a turn that
 * used a server-side tool), and `refusal` arrives as HTTP 200 with possibly
 * empty content, so it must be checked BEFORE reading content.
 */
export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "pause_turn"
  | "refusal"
  | "model_context_window_exceeded";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}
