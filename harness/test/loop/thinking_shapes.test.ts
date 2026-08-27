import { describe, expect, it } from "vitest";
import * as request from "../../src/loop/request_builder.js";
import type { Capabilities } from "../../src/providers/contract.js";

/**
 * The two extended-thinking shapes, and which one a request carries.
 *
 * Measured on Bedrock, because the split is per MODEL and not a version cutoff:
 *
 *   `{type:"adaptive"}` only      opus-4-7 — `"thinking.type.enabled" is not supported for this model`
 *   BOTH                          sonnet-4-6
 *   `{type:"enabled", budget}`    opus-4-1, opus-4-5, sonnet-4, sonnet-4-5, haiku-4-5
 *
 * Those five were running with NO extended thinking at all: an earlier fix cleared a 400 by
 * omitting `thinking` entirely, because `ProviderRequest.thinking` could not express their shape.
 * They support it; the type did not.
 *
 * Two constraints ride along, both measured, and both are why sizing is part of this test:
 *   * `budget_tokens` must be **≥ 1024** (512 → 400, "Input should be greater than or equal to 1024")
 *   * `max_tokens` must be **strictly greater** than the budget (an equal pair → 400)
 */

const BASE: Capabilities = {
  streaming: true,
  toolUse: true,
  toolUseWhileStreaming: true,
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
  adaptiveThinking: false,
  thinkingBudgetTokens: null,
  thinkingDisplaySummarized: false,
  effortLevels: [],
  promptCaching: false,
  minCacheablePrefixTokens: null,
  serverSideCompaction: false,
  contextEditing: false,
  serverSideTools: { webSearch: false, webFetch: false, codeExecution: false },
  liveModelDiscovery: true,
  serverSideRefusalFallback: false,
  midConversationSystemMessages: true,
  midConversationToolChanges: true,
};

const build = (capabilities: Capabilities, answerTokens?: number) =>
  request.build({
    model: "m",
    capabilities,
    systemPrompt: "S",
    tools: [],
    surface: [],
    ...(answerTokens === undefined ? {} : { answerTokens }),
    signal: new AbortController().signal,
  });

describe("a model with the newer adaptive knob", () => {
  const caps: Capabilities = { ...BASE, adaptiveThinking: true, thinkingDisplaySummarized: true };

  it("gets adaptive, with no budget", () => {
    expect(build(caps).thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("still gets adaptive when it ALSO accepts a budget", () => {
    // sonnet-4-6 accepts both. Preferring adaptive is POLICY — it is the shape the newer models are
    // tuned for — and the capability states only what the model accepts.
    const both: Capabilities = { ...caps, thinkingBudgetTokens: 8192 };
    expect(build(both).thinking).toEqual({ type: "adaptive", display: "summarized" });
  });
});

describe("a model with only the older budget shape", () => {
  const caps: Capabilities = { ...BASE, thinkingBudgetTokens: 8192 };

  it("gets `enabled` with its budget, instead of nothing at all", () => {
    // The whole point: these five profiles were sent no `thinking` field whatsoever.
    expect(build(caps).thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
  });

  it("sizes maxTokens STRICTLY above the budget", () => {
    // An equal pair is a 400. The budget is headroom ON TOP of the answer, exactly as the adaptive
    // headroom is.
    const built = build(caps);
    expect(built.maxTokens).toBeGreaterThan(8192);
  });

  it("shrinks the budget to fit a small output ceiling, keeping the strict inequality", () => {
    // A model whose ceiling cannot hold answer + budget must still send a VALID pair rather than one
    // the API refuses.
    const tight: Capabilities = { ...caps, maxOutputTokens: 6_000 };
    const built = build(tight, 4_000);

    expect(built.maxTokens).toBeLessThanOrEqual(6_000);
    const budget = (built.thinking as { budget_tokens?: number } | undefined)?.budget_tokens;
    expect(budget).toBeDefined();
    expect(built.maxTokens).toBeGreaterThan(budget as number);
  });

  it("omits thinking entirely when the ceiling cannot fit the 1024 floor", () => {
    // Below the measured floor the API refuses the request, so no thinking is the only valid
    // request — and silently sending 1024 anyway would 400 the turn.
    const tiny: Capabilities = { ...caps, maxOutputTokens: 1_200 };
    const built = build(tiny, 1_000);

    expect(built.thinking).toBeUndefined();
    expect(built.maxTokens).toBeLessThanOrEqual(1_200);
  });

  it("never sends a budget below the measured floor", () => {
    for (const ceiling of [1_100, 2_000, 4_000, 64_000]) {
      const built = build({ ...caps, maxOutputTokens: ceiling }, 900);
      const budget = (built.thinking as { budget_tokens?: number } | undefined)?.budget_tokens;
      if (budget !== undefined) {
        expect(budget, `ceiling ${ceiling}`).toBeGreaterThanOrEqual(1024);
        expect(built.maxTokens, `ceiling ${ceiling}`).toBeGreaterThan(budget);
      }
    }
  });
});

describe("a model with neither shape", () => {
  it("gets no thinking field at all", () => {
    // Every Converse model, and the conservative fallback for an unmeasured Anthropic one: omitting
    // `thinking` works everywhere, so it is the safe default.
    expect(build(BASE).thinking).toBeUndefined();
  });

  it("sizes maxTokens with no thinking headroom", () => {
    expect(build(BASE, 4_000).maxTokens).toBe(4_000);
  });
});
