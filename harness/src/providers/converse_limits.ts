/**
 * Per-model output-token ceilings for Converse, and the request sizing they make safe.
 *
 * Bedrock's `ListFoundationModels` reports modality and streaming support and says NOTHING about
 * the output ceiling, so `bedrock_converse.ts` used a flat 8192. Bedrock does report it — only
 * when refusing: an over-limit `maxTokens` returns `ValidationException: The maximum tokens you
 * requested exceeds the model limit of 32768`. `npm run probe:limits` asks every model once with
 * an absurd budget and reads the number out of its refusal; no request is billed, because a
 * validation rejection generates no tokens. The result is committed
 * (`test/fixtures/converse/model_limits.json`) and `converse_limits.test.ts` pins every row.
 *
 * Measured 2026-08-16 in us-west-2, and both surprises argue against ever guessing this:
 *   - `nova-2-lite` is 65535 while `nova-lite`/`micro`/`pro` are 10000 — a family-prefix table
 *     would have been wrong by 6x on a member of the family it named.
 *   - every Llama and both Palmyras are EXACTLY 8192, so the old constant was right for 7 of 17
 *     models and low by up to 16x on the rest. Nothing measured is below it, which is why the
 *     flat value never killed a run.
 */

/** What an UNMEASURED model gets. Erring low truncates; erring high kills the run. */
export const CONSERVATIVE_MAX_OUTPUT_TOKENS = 8192;

/**
 * Room for reasoning ON TOP of the answer budget the loop asked for.
 *
 * The same 8192 the request builder adds for Anthropic adaptive thinking, applied for the same
 * reason: Converse bills reasoning against the SAME output budget as the answer, so a request for
 * "8192 tokens of answer" that does not account for reasoning is a request for 8192 tokens of
 * both. Measured on `us.deepseek.r1-v1:0`: a 300-token budget produced 947 characters of
 * reasoning and an EMPTY answer.
 */
export const REASONING_HEADROOM_TOKENS = 8192;

/**
 * Ceilings by model-id FRAGMENT, longest match first.
 *
 * Order matters: `amazon.nova-2-lite` must be tested before `amazon.nova`, or the family entry
 * would claim it.
 */
const CEILINGS: ReadonlyArray<readonly [fragment: string, ceiling: number]> = [
  ["openai.gpt-5.6", 131_072],
  ["mistral.pixtral-large", 131_072],
  ["amazon.nova-2-lite", 65_535],
  ["deepseek.r1", 32_768],
  ["amazon.nova-premier", 32_000],
  ["amazon.nova-micro", 10_000],
  ["amazon.nova-lite", 10_000],
  ["amazon.nova-pro", 10_000],
  ["meta.llama", 8_192],
  ["writer.palmyra", 8_192],
];

export function converseMaxOutputTokens(modelId: string): number {
  for (const [fragment, ceiling] of CEILINGS) {
    if (modelId.includes(fragment)) return ceiling;
  }
  return CONSERVATIVE_MAX_OUTPUT_TOKENS;
}

/**
 * The `maxTokens` to actually send: the loop's answer budget plus reasoning headroom, clamped to
 * what the model accepts.
 *
 * This is the adapter's job, not the loop's, for the same reason the streaming-vs-not choice is:
 * the loop states how much ANSWER it wants, and each provider expresses that in its own terms.
 * Converse having no separate reasoning budget is a Converse fact.
 */
export function sizeConverseMaxTokens(modelId: string, answerTokens: number): number {
  return Math.min(answerTokens + REASONING_HEADROOM_TOKENS, converseMaxOutputTokens(modelId));
}
