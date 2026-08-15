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
}

export type ProbeResult =
  /** `credentialSource` is an IDENTITY. The value never leaves the adapter. */
  | { available: true; credentialSource: CredentialSourceId }
  | { available: false; reason: ProviderUnavailableReason; remedy: string };

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
 * Note what is absent and must stay absent: `temperature`, `top_p`, `top_k`, and
 * `thinking.budget_tokens` all return 400 on current models (R10). They are not
 * optional-and-unused here; they have no field at all, so emitting one is a type
 * error rather than a runtime surprise.
 */
export interface ProviderRequest {
  model: string;
  /** Covers thinking AND text together — sizing for text alone truncates (R10). */
  maxTokens: number;
  system: SystemBlock[];
  messages: NeutralMessage[];
  tools: ToolSchema[];
  thinking?: { type: "adaptive" | "disabled"; display?: "summarized" | "omitted" };
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
