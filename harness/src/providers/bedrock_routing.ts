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
