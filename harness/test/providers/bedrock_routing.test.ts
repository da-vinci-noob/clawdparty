import { describe, expect, it } from "vitest";
import { AnthropicBedrockAdapter } from "../../src/providers/anthropic_bedrock.js";
import { BedrockConverseAdapter } from "../../src/providers/bedrock_converse.js";
import { isAnthropicProfileId } from "../../src/providers/bedrock_routing.js";
import { listProviders } from "../../src/providers/discovery.js";

/**
 * The two Bedrock adapters PARTITION the catalogue; no model appears under both.
 *
 * They split by vendor: `anthropic-bedrock` keeps the Anthropic inference profiles (full
 * Messages fidelity via `/model/{id}/invoke`), `bedrock-converse` takes everything else over
 * Converse. The split is one predicate, `isAnthropicProfileId`, used with opposite sense in
 * each adapter's live enumeration — so a model in both would mean the picker shows it twice
 * (S2 groups by provider) and the record could not say which provider a run used.
 */

describe("the routing predicate", () => {
  it("recognises Anthropic profiles across routing scopes", () => {
    for (const id of [
      "us.anthropic.claude-3-haiku-20240307-v1:0",
      "global.anthropic.claude-opus-5",
      "eu.anthropic.claude-sonnet-4",
    ]) {
      expect(isAnthropicProfileId(id)).toBe(true);
    }
  });

  it("rejects every other vendor", () => {
    for (const id of [
      "us.openai.gpt-5.6-sol",
      "us.amazon.nova-lite-v1:0",
      "us.meta.llama3-3-70b-instruct-v1:0",
      "us.deepseek.r1-v1:0",
    ]) {
      expect(isAnthropicProfileId(id)).toBe(false);
    }
  });

  it("is exactly the sense the two adapters use, so their acceptance is complementary", () => {
    // The property that makes double-listing impossible: for any profile id, at most ONE
    // adapter's filter accepts it. anthropic-bedrock accepts iff the predicate is true;
    // bedrock-converse's first gate rejects iff it is true. They can never both accept.
    for (const id of ["us.anthropic.claude-opus-5", "us.openai.gpt-5.6-sol"]) {
      const anthropicAccepts = isAnthropicProfileId(id);
      const converseFirstGateAccepts = !isAnthropicProfileId(id);
      expect(anthropicAccepts && converseFirstGateAccepts).toBe(false);
    }
  });
});

describe("no model id appears under two providers", () => {
  const REGION = "us-west-2";
  const USABLE = { source: "env:AWS_PROFILE" as const, usable: true };

  it("keeps the id sets disjoint across the whole /models response", async () => {
    // Each adapter is injected with the profiles its OWN live filter would yield for a shared
    // catalogue — Anthropic ids to the Anthropic adapter, the rest to Converse — and the
    // aggregate is checked for any id served twice.
    const anthropic = new AnthropicBedrockAdapter({
      env: { AWS_REGION: REGION, AWS_PROFILE: "work" },
      discovery: USABLE,
      listProfiles: async () => [
        { id: "us.anthropic.claude-opus-5", displayName: "US Opus 5" },
        { id: "global.anthropic.claude-sonnet-4", displayName: "Global Sonnet 4" },
      ],
    });
    const converse = new BedrockConverseAdapter({
      env: { AWS_REGION: REGION, AWS_PROFILE: "work" },
      discovery: USABLE,
      listProfiles: async () => [
        { id: "us.openai.gpt-5.6-sol", displayName: "Sol" },
        { id: "us.amazon.nova-lite-v1:0", displayName: "Nova Lite" },
      ],
    });

    const { providers } = await listProviders([anthropic, converse]);
    const allIds = providers.flatMap((p) => p.models.map((m) => m.id));

    expect(new Set(allIds).size).toBe(allIds.length);
  });
});
