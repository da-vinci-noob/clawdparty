import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PRICING_FILE_ENV,
  type PriceTable,
  costOf,
  loadPriceTable,
  priceFor,
  pricingPath,
} from "../src/pricing.js";

/**
 * A real cost, from a HOST-OWNED table.
 *
 * An earlier change made `total_cost_usd` honest (`null` = unknown, never `0` for a request that
 * was made). This computes it when the host has supplied prices and keeps returning `null` when
 * they have not, which is the rule that must survive: a confidently wrong cost is worse than a
 * stated unknown, because it would be believed.
 *
 * The prices below are TEST FIXTURES with round numbers chosen so the arithmetic is checkable by
 * hand. No price ships in this repo — see `src/pricing.ts` for why.
 */

const usage = (over: Partial<Record<string, number>> = {}) => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  ...over,
});

// $10 per million in, $30 out — deliberately round, so every expectation below is arithmetic a
// reader can verify without a calculator.
const TABLE: PriceTable = {
  "claude-sonnet-4-6": { input: 10, output: 30, cacheRead: 1, cacheWrite: 12.5 },
  "claude-opus-4": { input: 100, output: 300 },
  "claude-opus-4-8": { input: 200, output: 600 },
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-pricing-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeTable(contents: string): Record<string, string> {
  const file = join(dir, "pricing.json");
  writeFileSync(file, contents);
  return { [PRICING_FILE_ENV]: file };
}

describe("an unpriced model", () => {
  it("reports null, never 0", () => {
    // The honesty rule, preserved. `0` claims a request that was made was free.
    expect(costOf("some-model-nobody-priced", usage({ input_tokens: 5000 }), TABLE)).toBeNull();
  });

  it("reports null with an EMPTY table, which is the default state of every host", () => {
    expect(costOf("claude-sonnet-4-6", usage({ input_tokens: 5000 }), {})).toBeNull();
  });
});

describe("the arithmetic", () => {
  it("prices input and output at their own rates", () => {
    // 1,000,000 × $10/M + 1,000,000 × $30/M = $40.
    const cost = costOf(
      "claude-sonnet-4-6",
      usage({ input_tokens: 1_000_000, output_tokens: 1_000_000 }),
      TABLE,
    );
    expect(cost).toBeCloseTo(40, 10);
  });

  it("prices cache reads at the cache rate, not the input rate", () => {
    // 1M cache reads at $1/M is $1. At the input rate it would be $10 — a tenfold overstatement
    // on exactly the long sessions this app exists for.
    expect(
      costOf("claude-sonnet-4-6", usage({ cache_read_input_tokens: 1_000_000 }), TABLE),
    ).toBeCloseTo(1, 10);
  });

  it("prices cache writes at the write rate", () => {
    expect(
      costOf("claude-sonnet-4-6", usage({ cache_creation_input_tokens: 1_000_000 }), TABLE),
    ).toBeCloseTo(12.5, 10);
  });

  it("falls back to the input rate when no cache rate is given", () => {
    // `claude-opus-4` declares only input/output. Charging cache reads at input is the
    // conservative reading of an incomplete row, and it is stated rather than silently zero.
    expect(
      costOf("claude-opus-4", usage({ cache_read_input_tokens: 1_000_000 }), TABLE),
    ).toBeCloseTo(100, 10);
  });

  it("returns 0 for a run that genuinely used no tokens", () => {
    // Distinct from `null`: the model IS priced, and zero tokens really did cost nothing.
    expect(costOf("claude-sonnet-4-6", usage(), TABLE)).toBe(0);
  });
});

describe("matching a model id across access paths", () => {
  it("matches a bare first-party id exactly", () => {
    expect(priceFor("claude-sonnet-4-6", TABLE)?.input).toBe(10);
  });

  it("matches a Bedrock inference-profile id that embeds the model name", () => {
    // One table entry has to cover `claude-sonnet-4-6`, `global.anthropic.claude-sonnet-4-6` and
    // `us.anthropic.claude-sonnet-4-6-20260101-v1:0`, or the same model is priced on one path and
    // unknown on another.
    for (const id of [
      "global.anthropic.claude-sonnet-4-6",
      "us.anthropic.claude-sonnet-4-6-20260101-v1:0",
    ]) {
      expect(priceFor(id, TABLE)?.input, id).toBe(10);
    }
  });

  it("prefers the LONGEST matching key", () => {
    // With both `claude-opus-4` and `claude-opus-4-8` present, a first-match rule would price
    // Opus 4.8 at Opus 4's rate — a wrong number reported confidently.
    expect(priceFor("us.anthropic.claude-opus-4-8", TABLE)?.input).toBe(200);
  });

  it("does not match an unrelated model", () => {
    expect(priceFor("us.deepseek.r1-v1:0", TABLE)).toBeNull();
  });
});

describe("loading the table", () => {
  it("reads a well-formed file", () => {
    const env = writeTable(JSON.stringify({ "claude-x": { input: 1, output: 2 } }));
    expect(loadPriceTable(env)).toEqual({ "claude-x": { input: 1, output: 2 } });
  });

  it("returns an empty table when there is no file at all", () => {
    // The DEFAULT state of every host, and not an error: it means every run honestly reports an
    // unknown cost rather than a fabricated 0.
    expect(loadPriceTable({ [PRICING_FILE_ENV]: join(dir, "nope.json") })).toEqual({});
  });

  it("does not throw on malformed JSON", () => {
    // A bad price file must not take down every run on the host.
    expect(loadPriceTable(writeTable("{ this is not json"))).toEqual({});
  });

  it("drops a row missing a rate but keeps the good ones", () => {
    const env = writeTable(
      JSON.stringify({ good: { input: 1, output: 2 }, bad: { input: 1 }, alsoBad: null }),
    );
    // One malformed row must not poison a table the host otherwise filled in correctly.
    expect(Object.keys(loadPriceTable(env))).toEqual(["good"]);
  });

  it("drops a negative or non-numeric rate", () => {
    const env = writeTable(
      JSON.stringify({ neg: { input: -1, output: 2 }, str: { input: "3", output: 4 } }),
    );
    expect(loadPriceTable(env)).toEqual({});
  });

  it("ignores a JSON array, which is not a table", () => {
    expect(loadPriceTable(writeTable("[1,2,3]"))).toEqual({});
  });

  it("defaults to the host config path when the env var is unset", () => {
    // Named so the runbook and the code cannot drift on where the file goes.
    expect(pricingPath({})).toMatch(/\.config\/clawdparty\/pricing\.json$/);
  });

  it("prefers the env var over the default path", () => {
    const explicit = join(dir, "elsewhere.json");
    expect(pricingPath({ [PRICING_FILE_ENV]: explicit })).toBe(explicit);
  });
});

describe("a directory where the file should be", () => {
  it("degrades to an empty table rather than throwing", () => {
    const asDir = join(dir, "pricing.json");
    mkdirSync(asDir);
    expect(loadPriceTable({ [PRICING_FILE_ENV]: asDir })).toEqual({});
  });
});
