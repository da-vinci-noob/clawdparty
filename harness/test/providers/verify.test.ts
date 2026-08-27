import { describe, expect, it } from "vitest";
import type {
  Capabilities,
  EntitlementPosture,
  ModelInfo,
  ProbeResult,
  ProviderAdapter,
  ProviderEvent,
  ProviderRequest,
} from "../../src/providers/contract.js";
import { VERIFY_MAX_TOKENS, verifyProvider } from "../../src/providers/verify.js";

/**
 * An auth test that actually tests auth.
 *
 * `probe()` is PRESENCE-ONLY: it answers "is there a credential and a region", which is what the
 * model picker needs and is not what "will a run work?" means. Two measured counter-examples from
 * this host: `us.amazon.nova-premier-v1:0` has a perfectly valid credential and is refused with an
 * entitlement error, and the `linear` MCP server returned `invalid_token` while being correctly
 * configured. A settings tab that reported those as OK would be a tab that lies.
 *
 * So verification SENDS A REAL REQUEST — the smallest one that proves the credential is accepted —
 * through the adapter's own `stream()`, which is the same path a run takes. Anything less is
 * inference dressed up as a check.
 */

const CAPS: Capabilities = {
  streaming: true,
  toolUse: true,
  toolUseWhileStreaming: true,
  contextWindow: 200_000,
  maxOutputTokens: 8192,
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

interface Options {
  probe?: ProbeResult;
  models?: ModelInfo[];
  stream?: (req: ProviderRequest) => AsyncIterable<ProviderEvent>;
}

function adapter(options: Options = {}): ProviderAdapter & { sent: ProviderRequest[] } {
  const sent: ProviderRequest[] = [];
  return {
    sent,
    id: "test-provider",
    displayName: "Test Provider",
    entitlement: {
      credentialKind: "api_key",
      thirdPartyClientPermitted: "yes",
      note: "",
    } as EntitlementPosture,
    probe: async () =>
      options.probe ?? { available: true, credentialSource: "env:ANTHROPIC_API_KEY" },
    listModels: async () => options.models ?? [{ id: "m1", displayName: "M1", capabilities: CAPS }],
    capabilities: () => CAPS,
    async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
      sent.push(req);
      if (options.stream) {
        yield* options.stream(req);
        return;
      }
      yield { t: "message_start", model: req.model };
      yield { t: "block_start", index: 0, kind: "text" };
      yield { t: "text_delta", index: 0, text: "ok" };
      yield { t: "block_stop", index: 0, block: { type: "text", text: "ok" } };
      yield {
        t: "message_delta",
        stopReason: "end_turn",
        usage: {
          input_tokens: 7,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
      yield { t: "message_stop" };
    },
  };
}

describe("a provider that works", () => {
  it("reports ok, with the model it proved it with", async () => {
    const a = adapter();
    const result = await verifyProvider(a);

    expect(result).toMatchObject({ id: "test-provider", ok: true, model: "m1" });
  });

  it("sends a REQUEST, not just a probe", async () => {
    const a = adapter();
    await verifyProvider(a);

    // The whole point. `probe()` already said "there is a credential"; only a request says the
    // provider accepts it.
    expect(a.sent).toHaveLength(1);
  });

  it("keeps the request as small as it can be", async () => {
    const a = adapter();
    await verifyProvider(a);

    // A verification that costs real output tokens would make people avoid running it.
    expect(a.sent[0]?.maxTokens).toBe(VERIFY_MAX_TOKENS);
    expect(a.sent[0]?.tools).toEqual([]);
    expect(a.sent[0]?.messages).toHaveLength(1);
  });

  it("reports the credential SOURCE, never a value", async () => {
    const result = await verifyProvider(
      adapter({ probe: { available: true, credentialSource: "profile:active" } }),
    );

    expect(result.credentialSource).toBe("profile:active");
  });

  it("reports the tokens it spent, so the cost is visible rather than implied", async () => {
    const result = await verifyProvider(adapter());
    expect(result.usage).toMatchObject({ input_tokens: 7, output_tokens: 1 });
  });
});

describe("a provider with no usable credential", () => {
  it("does not send a request it knows will fail", async () => {
    const a = adapter({
      probe: { available: false, reason: "no_credential", remedy: "Run aws sso login" },
    });
    const result = await verifyProvider(a);

    expect(result).toMatchObject({
      ok: false,
      reason: "no_credential",
      remedy: "Run aws sso login",
    });
    expect(a.sent).toHaveLength(0);
  });
});

describe("a provider whose credential is REJECTED", () => {
  it("reports the provider's own message, which is the diagnostic", async () => {
    // The case `probe()` cannot see: credential present, request refused. Measured twice on this
    // host — an entitlement gap on nova-premier and an invalid_token from a configured MCP server.
    const result = await verifyProvider(
      adapter({
        // biome-ignore lint/correctness/useYield: the throw IS the behaviour under test
        stream: async function* () {
          throw new Error("AccessDeniedException: You don't have access to the model");
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("AccessDeniedException");
  });

  it("survives a provider that lists no models at all", async () => {
    const result = await verifyProvider(adapter({ models: [] }));

    // Available but serving nothing is a real state (an entitled account with no model access),
    // and it must not read as a pass.
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no_models");
  });
});

describe("choosing what to verify with", () => {
  it("accepts an explicit model so a specific one can be tested", async () => {
    const a = adapter({
      models: [
        { id: "cheap", displayName: "Cheap", capabilities: CAPS },
        { id: "expensive", displayName: "Expensive", capabilities: CAPS },
      ],
    });
    const result = await verifyProvider(a, "expensive");

    expect(result.model).toBe("expensive");
    expect(a.sent[0]?.model).toBe("expensive");
  });

  it("refuses a model this provider does not serve, rather than sending it", async () => {
    const a = adapter();
    const result = await verifyProvider(a, "not-served");

    expect(result).toMatchObject({ ok: false, reason: "unknown_model" });
    expect(a.sent).toHaveLength(0);
  });
});
