import { describe, expect, it } from "vitest";
import { AnthropicBedrockAdapter } from "../../src/providers/anthropic_bedrock.js";
import { BedrockConverseAdapter } from "../../src/providers/bedrock_converse.js";
import {
  dedupeByModel,
  inferContextWindow,
  isAnthropicProfileId,
} from "../../src/providers/bedrock_routing.js";
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

/**
 * The two helpers that SURVIVED the deletion of `src/models.ts`.
 *
 * That module was the MVP's model discovery: `listModels`, `FALLBACK_MODELS`,
 * `listBedrockModels`, `listAnthropicApiModels`. Nothing called any of them once `GET /models`
 * moved to `providers/discovery.ts`, but the file still read as live truth and held the last
 * static model list in the harness — three hardcoded ids, exactly what  forbids offering.
 *
 * `inferContextWindow` and `dedupeByModel` were the real code in it, and they are not general
 * model discovery: both exist because of specific Bedrock control-plane behaviour, which is why
 * they live here now. `dedupeByModel` had NO direct coverage — it was exercised only through
 * `listModels`, so deleting that would have deleted its only test.
 */
describe("inferContextWindow", () => {
  it("maps the 1M families, in plain and inference-profile id form", () => {
    for (const id of [
      "claude-opus-4-8",
      "claude-sonnet-5",
      "us.anthropic.claude-sonnet-4-6-20260101-v1:0",
      "global.anthropic.claude-opus-4-7",
      "claude-fable-5",
    ]) {
      expect(inferContextWindow(id), id).toBe(1_000_000);
    }
  });

  it("maps haiku and any other CLAUDE model to 200K", () => {
    for (const id of ["claude-haiku-4-5-20251001", "us.anthropic.claude-haiku-4-5-v1:0"]) {
      expect(inferContextWindow(id), id).toBe(200_000);
    }
  });

  it("gives a non-Anthropic model the conservative window, not the old flat 200K", () => {
    // `us.deepseek.r1-v1:0` was asserted at 200_000 here, and a live measurement caught the defect: the
    // flat value OVER-declared every non-Anthropic model, and the four that named a window said
    // 131072. See `context_window.test.ts` for the measured rows.
    for (const id of ["us.deepseek.r1-v1:0", "totally-unknown"]) {
      expect(inferContextWindow(id), id).toBe(131_072);
    }
  });

  it("is case-insensitive, because profile ids are not normalised upstream", () => {
    expect(inferContextWindow("US.ANTHROPIC.CLAUDE-SONNET-5")).toBe(1_000_000);
  });
});

describe("dedupeByModel", () => {
  const profile = (id: string, label = id) => ({ id, label, context_window: 0 });

  it("collapses routing scopes to one entry, preferring global", () => {
    const deduped = dedupeByModel([
      profile("us.anthropic.claude-opus-5", "US Claude Opus 5"),
      profile("global.anthropic.claude-opus-5", "Global Claude Opus 5"),
      profile("eu.anthropic.claude-opus-5", "EU Claude Opus 5"),
    ]);

    // Without this the picker shows one model four times and a participant has to guess which
    // routing scope they want.
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.id).toBe("global.anthropic.claude-opus-5");
  });

  it("prefers us when there is no global profile", () => {
    const deduped = dedupeByModel([
      profile("apac.anthropic.claude-sonnet-4"),
      profile("us.anthropic.claude-sonnet-4"),
      profile("eu.anthropic.claude-sonnet-4"),
    ]);

    expect(deduped[0]?.id).toBe("us.anthropic.claude-sonnet-4");
  });

  it("keeps DIFFERENT models apart, however similar their ids", () => {
    const deduped = dedupeByModel([
      profile("us.anthropic.claude-opus-5"),
      profile("us.anthropic.claude-opus-4-8"),
      profile("global.anthropic.claude-sonnet-4-6"),
    ]);

    // Over-collapsing would silently remove models the host can serve.
    expect(deduped.map((p) => p.id).sort()).toEqual([
      "global.anthropic.claude-sonnet-4-6",
      "us.anthropic.claude-opus-4-8",
      "us.anthropic.claude-opus-5",
    ]);
  });

  it("falls back to the whole id when there is no vendor segment to key on", () => {
    const deduped = dedupeByModel([profile("some-bare-model"), profile("another-bare-model")]);

    expect(deduped).toHaveLength(2);
  });

  it("preserves the winning entry's label, not just its id", () => {
    const deduped = dedupeByModel([
      profile("us.anthropic.claude-opus-5", "US Claude Opus 5"),
      profile("global.anthropic.claude-opus-5", "Global Claude Opus 5"),
    ]);

    // The label is what the picker shows; keeping the id and dropping the label would leave a
    // dropdown entry naming the wrong routing scope.
    expect(deduped[0]?.label).toBe("Global Claude Opus 5");
  });

  it("returns an empty list unchanged rather than throwing", () => {
    expect(dedupeByModel([])).toEqual([]);
  });
});
