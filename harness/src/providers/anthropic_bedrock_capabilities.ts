/**
 * Per-MODEL Anthropic capabilities on Bedrock.
 *
 * `anthropic_bedrock.ts` applied ONE static capability table to all 20+ Anthropic inference
 * profiles. That is right about the newest models and wrong about the rest: selecting Opus 4.1
 * sent `thinking: {type:"adaptive"}` and the API refused the entire request with
 * `400 thinking: Input tag 'adaptive' found using 'type' does not match any of the expected
 * tags: 'enabled', 'disabled'`. A per-provider table cannot express a per-model feature, which
 * is the same mistake `toolUseWhileStreaming` was added to stop making.
 *
 * Measured 2026-08-17 in us-west-2 across every Anthropic profile the account lists, probing
 * `thinking.adaptive` and `output_config.effort` separately. They track each other EXACTLY — a
 * model takes both or neither — so one predicate gates both.
 *
 * Regenerating: the probe is a few tiny requests per model; re-run it when Bedrock adds a
 * family, and update `ANTHROPIC_BEDROCK_MEASURED_AT`.
 */

export const ANTHROPIC_BEDROCK_MEASURED_AT = "2026-08-17";

/**
 * Model-id fragments measured to ACCEPT `thinking: {type:"adaptive"}` and `output_config.effort`.
 *
 * Fragments include the full version segment on purpose. `opus-5` must not match
 * `claude-opus-4-5-…` and `sonnet-5` must not match `claude-sonnet-4-5-…` — those two are
 * measured NOT to support adaptive thinking, so a loose fragment would 400 an entire family.
 */
const ADAPTIVE_THINKING = [
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
];

/**
 * Fragments this host cannot serve AT ALL — measured with a plain request carrying no optional
 * parameters, so no capability flag can rescue them, and  forbids offering them.
 *
 *  - `claude-3-…`: `404 This model version has reached the end of its life.`
 *  - `claude-fable-5`: `400 data retention mode 'default' is not available for this model` —
 *    an account posture rather than a capability. If the account's data-retention setting
 *    changes, drop it from this list and re-probe.
 */
const NOT_SERVABLE = ["claude-3-", "claude-fable-5"];

const has = (modelId: string, fragments: readonly string[]): boolean =>
  fragments.some((fragment) => modelId.includes(fragment));

/**
 * Whether this model accepts adaptive thinking and an effort level.
 *
 * Defaults to FALSE for anything unmeasured, which is the safe direction: omitting `thinking`
 * works on every model, while sending an unsupported one is a 400 that kills the run. A wrong
 * `false` costs a feature; a wrong `true` costs the turn.
 */
export function supportsAdaptiveThinking(modelId: string): boolean {
  return has(modelId, ADAPTIVE_THINKING);
}

/** Whether the host can serve this profile at all. */
export function isServableAnthropicProfile(modelId: string): boolean {
  return !has(modelId, NOT_SERVABLE);
}
