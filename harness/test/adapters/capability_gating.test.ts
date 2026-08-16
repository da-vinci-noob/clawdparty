import { describe, expect, it } from "vitest";
import { build } from "../../src/loop/request_builder.js";
import { AnthropicBedrockAdapter } from "../../src/providers/anthropic_bedrock.js";
import { AnthropicDirectAdapter } from "../../src/providers/anthropic_direct.js";
import { AnthropicOauthAdapter } from "../../src/providers/anthropic_oauth.js";
import { buildAdapters } from "../../src/providers/index.js";
import { buildRegistry } from "../../src/supervisor.js";

/**
 * R4 — a provider is offered only what it can actually serve, and the LOOP
 * decides that from `capabilities()` rather than from an adapter id.
 *
 * R4 is the most consequential Phase-0 finding: Bedrock has no web search, no web fetch, no
 * code execution and no automatic prompt caching. Two of those are tools the composer offers.
 * The rejected alternative was a lowest-common-denominator tool set, which would have deleted
 * web search from first-party sessions to accommodate Bedrock — paying for provider breadth
 * in capability everyone loses.
 *
 * So the gate has to be per-provider, and the assertions below are about the REQUEST that
 * comes out, not about a flag someone remembered to read. A capability declared and then
 * ignored is the same bug as one declared wrongly.
 */

const SIGNAL = new AbortController().signal;

function bedrockCaps() {
  return new AnthropicBedrockAdapter({ env: { AWS_REGION: "us-east-1" } }).capabilities(
    "anthropic.claude-opus-4-8",
  );
}

describe("Bedrock declares the gap R4 found", () => {
  const caps = bedrockCaps();

  it("has no web search, web fetch or code execution", () => {
    expect(caps.serverSideTools).toEqual({
      webSearch: false,
      webFetch: false,
      codeExecution: false,
    });
  });

  it("has no automatic prompt caching, and no cacheable-prefix minimum either", () => {
    // `null` rather than a number: a minimum implies caching exists, and `request_builder`
    // would spend breakpoints out of a budget of four that can never be cashed.
    expect(caps.promptCaching).toBe(false);
    expect(caps.minCacheablePrefixTokens).toBeNull();
  });

  it("has no live CAPABILITY discovery, even though model ids are enumerable", () => {
    // The distinction the flag name invites getting wrong: AWS can list inference profiles,
    // so models are discoverable; the Models API that reports per-model budgets and feature
    // flags is first-party only. The flag is about the latter.
    expect(caps.liveModelDiscovery).toBe(false);
    expect(caps.contextWindow).toBeGreaterThan(0);
  });

  it("has no server-side refusal fallback", () => {
    expect(caps.serverSideRefusalFallback).toBe(false);
  });

  it("still supports the things it does support, so this is not a blanket false", () => {
    // A capability table of all-false would pass every assertion above and make the adapter
    // useless. Streaming and tool use are the point of having it.
    expect(caps.streaming).toBe(true);
    expect(caps.toolUse).toBe(true);
    expect(caps.adaptiveThinking).toBe(true);
    expect(caps.effortLevels.length).toBeGreaterThan(0);
  });
});

describe("the tool set handed to a request is gated by capabilities", () => {
  const registry = buildRegistry();

  it("never offers web_search or web_fetch to a Bedrock-capability adapter", () => {
    const schemas = registry.schemasFor(bedrockCaps(), []);
    const names = schemas.map((s) => s.name);

    // The actual  consequence: offering a tool the provider does not have produces a
    // 400 mid-run, which reads to a participant as Claude breaking.
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("web_fetch");
  });

  it("DOES offer them to a first-party adapter", () => {
    const firstParty = {
      ...bedrockCaps(),
      serverSideTools: { webSearch: true, webFetch: true, codeExecution: true },
    };

    const names = registry.schemasFor(firstParty, []).map((s) => s.name);

    // Without this the previous test would pass on a registry that offers no web tools at
    // all, and the gate would be indistinguishable from the feature being absent.
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch");
  });

  it("still offers the local tools on Bedrock", () => {
    const names = registry.schemasFor(bedrockCaps(), []).map((s) => s.name);

    // Local tools run in the harness, not at the provider, so a provider's gaps must not
    // remove them — a Bedrock session that could not read a file would be pointless.
    expect(names).toContain("bash");
    expect(names.length).toBeGreaterThan(2);
  });
});

describe("the assembled request reflects the capability, not the adapter id", () => {
  it("omits thinking and caching markers for a provider that lacks them", () => {
    const caps = {
      ...bedrockCaps(),
      adaptiveThinking: false,
      promptCaching: false,
    };

    const req = build({
      model: "anthropic.claude-opus-4-8",
      capabilities: caps,
      systemPrompt: "S".repeat(8_000),
      tools: [],
      surface: [],
      signal: SIGNAL,
    });

    expect(req.thinking).toBeUndefined();
    expect(req.cacheBreakpoints).toEqual([]);
    // A `cache_control` marker on a provider without caching is ignored at best; the point
    // is that the builder reads the flag rather than assuming first-party behaviour.
    expect(JSON.stringify(req.system)).not.toContain("cache_control");
  });

  it("omits `compaction` unless the provider serves it", () => {
    const req = build({
      model: "anthropic.claude-opus-4-8",
      capabilities: bedrockCaps(),
      systemPrompt: "S",
      tools: [],
      surface: [],
      signal: SIGNAL,
    });

    expect(req.compaction).toBeUndefined();
  });

  it("drops an effort level the provider does not list", () => {
    const req = build({
      model: "m",
      capabilities: { ...bedrockCaps(), effortLevels: ["low"] },
      systemPrompt: "S",
      tools: [],
      surface: [],
      effort: "max",
      signal: SIGNAL,
    });

    // Sending an unsupported effort is a 400. Dropping it silently is the right call here
    // because the alternative — failing the run — is worse than answering at a lower effort.
    expect(req.effort).toBeUndefined();
  });
});

describe("no adapter id leaks into the loop", () => {
  it("every registered adapter answers capabilities() totally", () => {
    for (const adapter of buildAdapters()) {
      const caps = adapter.capabilities("claude-opus-4-8");

      // a PARTIAL capability object is indistinguishable from "unsupported", so a
      // missing field silently disables a feature. Every field, every adapter.
      for (const key of [
        "streaming",
        "toolUse",
        "contextWindow",
        "maxOutputTokens",
        "adaptiveThinking",
        "thinkingDisplaySummarized",
        "effortLevels",
        "promptCaching",
        "minCacheablePrefixTokens",
        "serverSideCompaction",
        "contextEditing",
        "serverSideTools",
        "liveModelDiscovery",
        "serverSideRefusalFallback",
        "midConversationSystemMessages",
        "midConversationToolChanges",
      ]) {
        expect(caps, `${adapter.id} is missing ${key}`).toHaveProperty(key);
      }
    }
  });

  it("declares DIFFERENT capabilities per provider, so the seam is load-bearing", async () => {
    // Capabilities come from `listModels()`, so the cache has to be filled first. Asking for
    // an unlisted model returns each adapter's CONSERVATIVE FALLBACK, which is all-false on
    // both — comparing those showed no difference and said nothing about the real tables.
    const listing = {
      models: {
        list: async () => ({
          data: [
            {
              id: "claude-opus-4-8",
              display_name: "Claude Opus 4.8",
              max_input_tokens: 1_000_000,
              max_tokens: 64_000,
              capabilities: { code_execution: { supported: true } },
            },
          ],
        }),
      },
    };
    const direct = new AnthropicDirectAdapter({ client: listing as never });
    const oauth = new AnthropicOauthAdapter({ client: listing as never });
    await direct.listModels();
    await oauth.listModels();

    // If all three agreed, `capabilities()` would be ceremony and the loop could hardcode.
    // The whole seam earns its cost because Bedrock genuinely differs.
    expect(bedrockCaps().serverSideTools).not.toEqual(
      direct.capabilities("claude-opus-4-8").serverSideTools,
    );
    expect(bedrockCaps().liveModelDiscovery).not.toBe(
      oauth.capabilities("claude-opus-4-8").liveModelDiscovery,
    );
    // And the two first-party paths AGREE with each other, which is the other half of the
    // claim: the difference tracks the provider, not the adapter count.
    expect(direct.capabilities("claude-opus-4-8").serverSideTools).toEqual(
      oauth.capabilities("claude-opus-4-8").serverSideTools,
    );
  });
});
