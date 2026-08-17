import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Usage } from "./providers/contract.js";

/**
 * What a run cost, from a HOST-OWNED price table.
 *
 * An earlier change made `total_cost_usd` honest — `null` means unknown rather than free. This
 * computes it when the host has supplied prices, and keeps returning `null` when they have not. A
 * run that reports `0` for a request that was actually made is a false claim, and that rule
 * survives here intact: an unpriced model yields `null`, never zero.
 *
 * **Why the table is host-owned and not compiled in.** Three reasons, in order of weight:
 *
 *  1. **Prices are not mine to assert.** Hardcoding figures into this repo would ship numbers
 *     nobody had verified against the vendor, and a confidently wrong cost is worse than a stated
 *     unknown — it would be believed.
 *  2. **They vary by region and by contract.** Bedrock prices differ per region, and an
 *     enterprise agreement differs from list. One table in source is wrong for someone.
 *  3. **They change.** A compiled-in table goes stale silently; a file the host maintains is
 *     visibly theirs to update, which is what "a maintained table" means.
 *
 * **Bedrock was assumed to expose no pricing API. That is not quite right, and the correction
 * matters for whoever automates this next.** The AWS Price List API does serve Bedrock — service
 * code `AmazonBedrock` is accepted. Measured on this host:
 *
 *     AccessDeniedException … not authorized to perform: pricing:GetProducts
 *
 * an authorization failure, not an unknown service. So the future path is real: grant
 * `pricing:GetProducts`, add `@aws-sdk/client-pricing`, and populate this table from the API per
 * region instead of by hand. It is not done here because it needs an IAM change this host does not
 * have, and it would price only the Bedrock paths — the first-party ones still need a table.
 */

/** Dollars per MILLION tokens, which is how every vendor publishes them. */
export interface ModelPrice {
  input: number;
  output: number;
  /** Cache reads are cheaper than fresh input; omitted means "same as input". */
  cacheRead?: number;
  /** Writing to the cache usually costs a premium over input; omitted means "same as input". */
  cacheWrite?: number;
}

export type PriceTable = Record<string, ModelPrice>;

/**
 * Where the table comes from, in precedence order:
 *
 *   1. `HARNESS_PRICING_FILE` — an explicit path, which is what a test or a non-standard layout
 *      uses.
 *   2. `~/.config/clawdparty/pricing.json` — the host's own table.
 *
 * A missing file is not an error. It is the default state, and it means every run honestly
 * reports an unknown cost.
 */
export const PRICING_FILE_ENV = "HARNESS_PRICING_FILE";
export const DEFAULT_PRICING_PATH = join(".config", "clawdparty", "pricing.json");

export function pricingPath(env: Record<string, string | undefined> = process.env): string {
  return env[PRICING_FILE_ENV] ?? join(homedir(), DEFAULT_PRICING_PATH);
}

/**
 * Read the table, or `{}` when there is none.
 *
 * NEVER throws: a malformed price file must not take down every run on the host. It degrades to
 * "no prices known", which is the same state as having no file — and the same state the whole
 * feature started in.
 */
export function loadPriceTable(env: Record<string, string | undefined> = process.env): PriceTable {
  try {
    const parsed = JSON.parse(readFileSync(pricingPath(env), "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return sanitize(parsed as Record<string, unknown>);
  } catch {
    return {};
  }
}

/** Keep only entries that are actually usable, so one bad row cannot poison a good table. */
function sanitize(raw: Record<string, unknown>): PriceTable {
  const table: PriceTable = {};
  for (const [model, value] of Object.entries(raw)) {
    const price = value as Partial<ModelPrice> | null;
    if (!price || !isPositive(price.input) || !isPositive(price.output)) continue;
    table[model] = {
      input: price.input as number,
      output: price.output as number,
      ...(isPositive(price.cacheRead) ? { cacheRead: price.cacheRead as number } : {}),
      ...(isPositive(price.cacheWrite) ? { cacheWrite: price.cacheWrite as number } : {}),
    };
  }
  return table;
}

const isPositive = (n: unknown): boolean => typeof n === "number" && Number.isFinite(n) && n >= 0;

/**
 * Find the price for a model id.
 *
 * An EXACT key wins. Otherwise the longest key that the id CONTAINS wins, which is what makes one
 * entry cover a model across access paths: `claude-sonnet-4-6` matches the bare first-party id and
 * `global.anthropic.claude-sonnet-4-6` and `us.anthropic.claude-sonnet-4-6-...` alike, since a
 * Bedrock inference-profile id embeds the model name.
 *
 * Longest-match rather than first-match is load-bearing: with both `claude-opus-4` and
 * `claude-opus-4-8` in the table, a first-match rule would price Opus 4.8 as Opus 4 — a wrong
 * number reported confidently, which is the one outcome worse than reporting nothing.
 */
export function priceFor(model: string, table: PriceTable): ModelPrice | null {
  const exact = table[model];
  if (exact) return exact;

  let best: { key: string; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(table)) {
    if (!model.includes(key)) continue;
    if (best === null || key.length > best.key.length) best = { key, price };
  }
  return best?.price ?? null;
}

/**
 * The run's cost in USD, or `null` when this model has no price.
 *
 * Cache reads and cache writes are priced separately when the table says so, because on a long
 * session they dominate: charging cache reads at the full input rate would overstate the cost of
 * exactly the sessions this app is built for.
 */
export function costOf(model: string, usage: Usage, table: PriceTable): number | null {
  const price = priceFor(model, table);
  if (price === null) return null;

  const perToken = (perMillion: number): number => perMillion / 1_000_000;
  return (
    usage.input_tokens * perToken(price.input) +
    usage.output_tokens * perToken(price.output) +
    usage.cache_read_input_tokens * perToken(price.cacheRead ?? price.input) +
    usage.cache_creation_input_tokens * perToken(price.cacheWrite ?? price.input)
  );
}
