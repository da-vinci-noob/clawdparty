import type { Capabilities } from "./contract.js";

/**
 * Which Bedrock models may be offered, and with what capabilities.
 *
 * The rule is a TABLE because Bedrock exposes no flag for it. `ListFoundationModels` reports
 * modality and streaming support; it says nothing about tool use, and nothing at all about the
 * combination. The only source is a probe, so the probe's result is committed
 * (`test/fixtures/converse/model_matrix.json`, regenerate with `npm run probe:converse`) and
 * this file encodes what it found.
 *
 * Measured 2026-08-16 in us-west-2 across 18 distinct text-capable non-Anthropic profiles:
 *
 *   tools while streaming   amazon nova-{lite,micro,pro,2-lite}, openai gpt-5.6-{sol,terra,luna}
 *   tools only unstreamed   5x meta llama, mistral pixtral, 2x writer palmyra
 *   no tools at all         deepseek r1
 *   not invocable           amazon nova-premier (access denied), twelvelabs pegasus
 *
 * A table goes stale, which is the honest cost of a platform that will not answer the question.
 * `TABLE_MEASURED_AT` dates it, and `test/providers/converse_capabilities.test.ts` cross-checks
 * every entry against the committed matrix, so a re-probe that disagrees fails the build rather
 * than drifting quietly.
 */

export const TABLE_MEASURED_AT = "2026-08-16";

/** Model-id fragments whose family accepts a `toolConfig` on a STREAMING request. */
const STREAMS_TOOLS = [
  "openai.gpt-5.6",
  "amazon.nova-lite",
  "amazon.nova-micro",
  "amazon.nova-pro",
  "amazon.nova-2-lite",
];

/**
 * Model-id fragments that reject a `toolConfig` outright, in either transport.
 *
 * These models ARE offered — a declared `toolUse: false` is what makes them
 * representable, where an exclusion made R1 simply absent from the picker with no way to learn
 * why. They run answer-only; the loop refuses a run that offers them tools.
 */
const NO_TOOLS = ["deepseek.r1"];

/**
 * Model-id fragments this host cannot invoke at all, for reasons that are NOT capabilities:
 * an entitlement the account lacks, or a model Converse does not serve. Kept separate from
 * capability gating because the remedy is different — one is "ask for access", the other is
 * "this will never work here" — and  forbids offering either in the picker.
 */
const NOT_INVOCABLE = ["amazon.nova-premier", "twelvelabs.pegasus"];

const has = (modelId: string, fragments: readonly string[]): boolean =>
  fragments.some((fragment) => modelId.includes(fragment));

export function isInvocable(modelId: string): boolean {
  return !has(modelId, NOT_INVOCABLE);
}

/**
 * Whether this model can use tools at all.
 *
 * Defaults to TRUE for anything unmeasured, the opposite direction from
 * `toolUseWhileStreaming`, and deliberately: tool use is the norm — one model out of 18 lacks it
 * — so a wrong `false` would silently turn a capable model into a chat toy, while a wrong `true`
 * produces one refused run that names the model and the constraint.
 */
export function toolUse(modelId: string): boolean {
  return !has(modelId, NO_TOOLS);
}

/**
 * Whether tools may ride on a streaming request for this model.
 *
 * Defaults to FALSE for anything unmeasured. That is the safe direction: a wrong `false`
 * refuses a run with a message naming the constraint, while a wrong `true` sends a request the
 * provider rejects with `ValidationException` — an opaque failure for a knowable limit.
 */
export function toolUseWhileStreaming(modelId: string): boolean {
  return has(modelId, STREAMS_TOOLS);
}

/**
 * Capabilities for a Converse-served model.
 *
 * `promptCaching: false` is measured, not assumed: no `metadata.usage` in any captured
 * transcript carried a cache field, so a cache breakpoint would be placed and never honoured.
 */
export function converseCapabilities(
  modelId: string,
  contextWindow: number,
  maxOutputTokens: number,
): Capabilities {
  return {
    streaming: true,
    toolUse: toolUse(modelId),
    // A model with no tool use cannot have tools while streaming either; `toolUseWhileStreaming`
    // is measured per family and would say false anyway, but the `&&` makes the two consistent
    // by construction rather than by the table staying in step with itself.
    toolUseWhileStreaming: toolUse(modelId) && toolUseWhileStreaming(modelId),
    contextWindow,
    maxOutputTokens,
    // Converse exposes NEITHER thinking shape — no adaptive knob and no budget. Models that reason
    // do it on their own and report it as `reasoningContent`, which is not a budget anyone
    // can set.
    adaptiveThinking: false,
    thinkingBudgetTokens: null,
    thinkingDisplaySummarized: false,
    effortLevels: [],
    promptCaching: false,
    minCacheablePrefixTokens: null,
    serverSideCompaction: false,
    contextEditing: false,
    serverSideTools: { webSearch: false, webFetch: false, codeExecution: false },
    // ListFoundationModels + ListInferenceProfiles are real discovery, unlike the Anthropic
    // Bedrock path where the SDK exposes no models.list().
    liveModelDiscovery: true,
    serverSideRefusalFallback: false,
    midConversationSystemMessages: true,
    midConversationToolChanges: true,
  };
}
