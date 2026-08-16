import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONSERVATIVE_MAX_OUTPUT_TOKENS,
  converseMaxOutputTokens,
  sizeConverseMaxTokens,
} from "../../src/providers/converse_limits.js";

/**
 * The real output-token ceilings, and the headroom they make safe.
 *
 * The adapter used a flat 8192 because `ListFoundationModels` reports no output limit. Bedrock
 * does report it, just only when refused: an over-limit `maxTokens` comes back with
 * `ValidationException: The maximum tokens you requested exceeds the model limit of 32768`. One
 * rejected request per model, none of them billed — `npm run probe:limits`.
 *
 * Two things the measurement settled that a guess would have got wrong:
 *
 *   - **No model's ceiling is BELOW 8192.** The flat constant never killed a run, so the "erring
 *     low only truncates" reasoning held — it was conservative, not broken.
 *   - **`nova-2-lite` is 65535 while `nova-lite`/`micro`/`pro` are 10000.** A table keyed on the
 *     family fragment `amazon.nova` would have been wrong by 6x on one of its own members, which
 *     is why every row is pinned against the committed probe below.
 */

const FIXTURE = fileURLToPath(new URL("../fixtures/converse/model_limits.json", import.meta.url));

interface LimitsFixture {
  measured_at: string;
  rows: Array<{ profile_id: string; max_output_tokens: number | null }>;
}

const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as LimitsFixture;
const measured = fixture.rows.filter((r) => r.max_output_tokens !== null);

describe("the table agrees with the probe, row by row", () => {
  it("has rows to check, so this is not vacuously true", () => {
    expect(measured.length).toBeGreaterThan(15);
  });

  for (const row of measured) {
    it(`${row.profile_id} → ${row.max_output_tokens}`, () => {
      expect(converseMaxOutputTokens(row.profile_id)).toBe(row.max_output_tokens);
    });
  }

  it("never records the AWS account id", () => {
    // The rows carry Bedrock's verbatim error messages, which is the point (a message-format
    // change must be visible) and also the risk — the same rule the capture fixtures follow.
    expect(readFileSync(FIXTURE, "utf8")).not.toMatch(/\b\d{12}\b/);
  });

  it("records what the probe could not measure, rather than inventing a number", () => {
    // Pegasus is refused by Converse outright ("This action doesn't support the model"), so it has
    // no measurable ceiling. It is also not invocable, so nothing asks for one.
    const unmeasured = fixture.rows.filter((r) => r.max_output_tokens === null);
    expect(unmeasured.map((r) => r.profile_id)).toEqual(["us.twelvelabs.pegasus-1-2-v1:0"]);
  });
});

describe("a model the table has never seen", () => {
  it("gets the conservative floor, not an optimistic guess", () => {
    // Erring low truncates a long answer; erring high is a ValidationException that kills the
    // run. Every ceiling measured is >= this, so the floor is safe for anything new.
    expect(converseMaxOutputTokens("us.someone.brand-new-v9:0")).toBe(
      CONSERVATIVE_MAX_OUTPUT_TOKENS,
    );
    expect(CONSERVATIVE_MAX_OUTPUT_TOKENS).toBe(8192);
    for (const row of measured) {
      expect(row.max_output_tokens).toBeGreaterThanOrEqual(CONSERVATIVE_MAX_OUTPUT_TOKENS);
    }
  });
});

describe("sizing the request", () => {
  // The loop asks for N tokens of ANSWER, and adds thinking headroom only for a provider with a
  // separate thinking budget. Converse has none: reasoning is billed against the same output
  // budget as the answer (measured — R1 spent an entire 300-token budget reasoning and returned
  // no answer at all), so expressing "N tokens of answer" here means asking for more than N.
  it("adds thinking headroom on top of the answer budget", () => {
    expect(sizeConverseMaxTokens("us.deepseek.r1-v1:0", 8192)).toBe(16_384);
  });

  it("never exceeds the model's measured ceiling", () => {
    // The reason the ceiling table is load-bearing rather than decorative: a uniform 16384 ask
    // would be a run-killing ValidationException on every Llama and both Palmyras.
    expect(sizeConverseMaxTokens("us.meta.llama3-3-70b-instruct-v1:0", 8192)).toBe(8192);
    expect(sizeConverseMaxTokens("us.writer.palmyra-x5-v1:0", 8192)).toBe(8192);
    expect(sizeConverseMaxTokens("us.amazon.nova-lite-v1:0", 8192)).toBe(10_000);
  });

  it("keeps a small explicit ask small — headroom is not a floor", () => {
    // A caller asking for 500 tokens means it; the headroom is for reasoning, and doubling a
    // deliberate small budget would make `answerTokens` meaningless.
    expect(sizeConverseMaxTokens("us.openai.gpt-5.6-sol", 500)).toBe(500 + 8192);
  });

  it("clamps an over-ceiling ask instead of forwarding it", () => {
    expect(sizeConverseMaxTokens("us.meta.llama4-scout-17b-instruct-v1:0", 999_999)).toBe(8192);
  });

  it("is safe for every measured model — the ask is never above the ceiling", () => {
    for (const row of measured) {
      const ask = sizeConverseMaxTokens(row.profile_id, 8192);
      expect(ask, `${row.profile_id} would be refused`).toBeLessThanOrEqual(
        row.max_output_tokens as number,
      );
    }
  });
});
