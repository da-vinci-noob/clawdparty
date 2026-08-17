/**
 * The single predicate that PARTITIONS the Bedrock catalogue between the two adapters.
 *
 * `anthropic-bedrock` serves the profiles this returns true for (full Messages fidelity);
 * `bedrock-converse` serves the rest. Used with opposite sense in each adapter's live
 * enumeration, so their acceptance is complementary and no model can appear under both — the
 * property `bedrock_routing.test.ts` pins. Duplicating the `includes("anthropic")` check in
 * two files was the way that guarantee could silently rot when one copy was loosened.
 */
export function isAnthropicProfileId(id: string): boolean {
  return id.toLowerCase().includes("anthropic");
}

/** The shape both helpers below work on — an id plus a label, before capabilities are attached. */
export interface BedrockProfile {
  id: string;
  label: string;
  context_window: number;
}

/**
 * Ids containing any of these tokens are 1M-token models.
 *
 * A LAST RESORT, and Bedrock-specific: `ListInferenceProfiles` reports no context window at all,
 * so something has to supply one. Every other source is preferred — the Anthropic API reports
 * `max_input_tokens`, and the per-model capability tables carry measured windows.
 */
const ONE_MILLION_FAMILIES = ["opus-4-8", "opus-4-7", "sonnet-5", "sonnet-4-6", "fable-5"];

export function inferContextWindow(id: string): number {
  const lower = id.toLowerCase();
  return ONE_MILLION_FAMILIES.some((token) => lower.includes(token)) ? 1_000_000 : 200_000;
}

/**
 * Collapse the routing-scope duplicates Bedrock returns for one model.
 *
 * Bedrock exposes a separate cross-region inference profile per scope (`global.`, `us.`, `eu.`,
 * `apac.`) for the SAME model, so a raw listing yields "Global Claude Opus 5" next to "US Claude
 * Opus 5". Without this the picker shows one model four times and a participant has to guess
 * which routing scope they want.
 *
 * Preference order is `global` (region-agnostic) → `us` → `eu` → `apac` → anything else.
 */
const PROFILE_PREFIX_RANK: Record<string, number> = { global: 0, us: 1, eu: 2, apac: 3 };

export function dedupeByModel(models: BedrockProfile[]): BedrockProfile[] {
  // Key on the model part — everything from the vendor segment on — so the scope prefix is
  // ignored. Falls back to the whole id for anything that does not look like a profile id.
  const baseKey = (id: string): string => {
    const i = id.toLowerCase().indexOf("anthropic.");
    return i === -1 ? id.toLowerCase() : id.slice(i).toLowerCase();
  };
  const rank = (id: string): number => {
    const prefix = id.split(".")[0]?.toLowerCase() ?? "";
    return PROFILE_PREFIX_RANK[prefix] ?? 9;
  };
  const best = new Map<string, BedrockProfile>();
  for (const model of models) {
    const key = baseKey(model.id);
    const existing = best.get(key);
    if (!existing || rank(model.id) < rank(existing.id)) {
      best.set(key, model);
    }
  }
  return [...best.values()];
}
