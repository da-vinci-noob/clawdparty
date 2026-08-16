import { describe, expect, it, vi } from "vitest";
import {
  BedrockConverseAdapter,
  type BedrockConverseOptions,
} from "../../src/providers/bedrock_converse.js";
import type { ProviderEvent, ProviderRequest } from "../../src/providers/contract.js";
import { type ConverseScenario, loadCapture } from "../providers/converse_fixture.js";
import { assertTotalCapabilities } from "./conformance.js";

/**
 * The bedrock-converse adapter, end to end without an AWS account.
 *
 * The stream is driven by REPLAYING the captured transcripts through the adapter's injected runner,
 * so `stream()` exercises the real request translation and the real event mapping — the two
 * pieces most likely to be wrong, both written against captured bytes.
 */

const REGION = "us-west-2";
const USABLE = { source: "env:AWS_PROFILE" as const, usable: true };

function replayRunner(scenario: ConverseScenario) {
  const events = loadCapture(scenario).events;
  return async function* () {
    for (const event of events) yield event;
  };
}

function adapter(over: BedrockConverseOptions = {}) {
  return new BedrockConverseAdapter({
    env: { AWS_REGION: REGION, AWS_PROFILE: "work" },
    discovery: USABLE,
    listProfiles: async () => [
      { id: "us.openai.gpt-5.6-sol", displayName: "US OpenAI GPT-5.6 Sol" },
      { id: "us.amazon.nova-lite-v1:0", displayName: "US Nova Lite" },
    ],
    ...over,
  });
}

function request(over: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: "us.amazon.nova-lite-v1:0",
    maxTokens: 400,
    system: [{ type: "text", text: "test" }],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    cacheBreakpoints: [],
    signal: new AbortController().signal,
    ...over,
  };
}

async function collect(gen: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("identity and entitlement", () => {
  it("registers under a distinct id from the Anthropic Bedrock adapter", () => {
    expect(adapter().id).toBe("bedrock-converse");
  });

  it("declares the host's own AWS account, third-party permitted", () => {
    expect(adapter().entitlement).toMatchObject({
      credentialKind: "cloud_marketplace",
      thirdPartyClientPermitted: "yes",
    });
  });
});

describe("probe", () => {
  it("is available with a usable credential and a region", async () => {
    expect(await adapter().probe()).toEqual({
      available: true,
      credentialSource: "env:AWS_PROFILE",
    });
  });

  it("reports no_credential with a remedy when none is discovered", async () => {
    const a = adapter({
      discovery: { source: "none", usable: false, remedy: "run aws sso login" },
    });
    expect(await a.probe()).toMatchObject({ available: false, reason: "no_credential" });
  });

  it("reports missing region even with a credential", async () => {
    const a = new BedrockConverseAdapter({
      env: {},
      discovery: USABLE,
      listProfiles: async () => [],
    });
    const result = await a.probe();
    expect(result).toMatchObject({ available: false });
    if (!result.available) expect(result.remedy).toMatch(/region/i);
  });
});

describe("listModels — the capability gate", () => {
  it("serves the tool-capable models with their measured capabilities", async () => {
    const models = await adapter().listModels();
    const ids = models.map((m) => m.id);

    expect(ids).toContain("us.openai.gpt-5.6-sol");
    expect(ids).toContain("us.amazon.nova-lite-v1:0");
    for (const model of models) assertTotalCapabilities(model.capabilities, model.id);
  });

  it("drops a model this host cannot invoke (entitlement / not-servable / no tools)", async () => {
    const a = adapter({
      listProfiles: async () => [
        { id: "us.amazon.nova-lite-v1:0", displayName: "Nova Lite" },
        { id: "us.deepseek.r1-v1:0", displayName: "DeepSeek R1" }, // no tool support at all
        { id: "us.amazon.nova-premier-v1:0", displayName: "Nova Premier" }, // access denied
        { id: "us.twelvelabs.pegasus-1-2-v1:0", displayName: "Pegasus" }, // Converse won't serve
      ],
    });
    const ids = (await a.listModels()).map((m) => m.id);

    expect(ids).toEqual(["us.amazon.nova-lite-v1:0"]);
  });

  it("de-duplicates the us./global. profiles of one model", async () => {
    const a = adapter({
      listProfiles: async () => [
        { id: "us.openai.gpt-5.6-sol", displayName: "US Sol" },
        { id: "global.openai.gpt-5.6-sol", displayName: "Global Sol" },
      ],
    });
    expect(await a.listModels()).toHaveLength(1);
  });

  it("carries the measured toolUseWhileStreaming per model", async () => {
    const a = adapter({
      listProfiles: async () => [
        { id: "us.openai.gpt-5.6-sol", displayName: "Sol" },
        { id: "us.meta.llama3-3-70b-instruct-v1:0", displayName: "Llama" },
      ],
    });
    const models = await a.listModels();
    const byId = new Map(models.map((m) => [m.id, m.capabilities.toolUseWhileStreaming]));

    expect(byId.get("us.openai.gpt-5.6-sol")).toBe(true);
    expect(byId.get("us.meta.llama3-3-70b-instruct-v1:0")).toBe(false);
  });
});

describe("capabilities", () => {
  it("never claims prompt caching — Converse reports no cache fields", () => {
    expect(adapter().capabilities("us.openai.gpt-5.6-sol").promptCaching).toBe(false);
  });
});

describe("stream — real translation and mapping over a replayed capture", () => {
  it("maps a Nova text turn to the lifecycle the loop expects", async () => {
    const events = await collect(adapter({ runner: replayRunner("nova-text") }).stream(request()));
    const types = events.map((e) => e.t);

    expect(types[0]).toBe("message_start");
    expect(types.slice(-2)).toEqual(["message_delta", "message_stop"]);
    expect(events.some((e) => e.t === "text_delta")).toBe(true);
  });

  it("stamps the requested model id onto message_start (the stream omits it)", async () => {
    const events = await collect(
      adapter({ runner: replayRunner("nova-text") }).stream(
        request({ model: "us.amazon.nova-lite-v1:0" }),
      ),
    );
    expect(events[0]).toEqual({ t: "message_start", model: "us.amazon.nova-lite-v1:0" });
  });

  it("surfaces a tool call from an OpenAI tool-use turn", async () => {
    const events = await collect(
      adapter({ runner: replayRunner("openai-tool-use") }).stream(
        request({
          model: "us.openai.gpt-5.6-sol",
          tools: [{ name: "read_file", input_schema: { type: "object" } }],
        }),
      ),
    );
    const stop = events.find(
      (e): e is Extract<ProviderEvent, { t: "block_stop" }> => e.t === "block_stop",
    );

    // Canonical shape the loop extracts tool calls from — see converse_stream.verbatim.
    expect((stop?.block as { type?: string; name?: string }).type).toBe("tool_use");
    expect((stop?.block as { name?: string }).name).toBe("read_file");
    const delta = events.find(
      (e): e is Extract<ProviderEvent, { t: "message_delta" }> => e.t === "message_delta",
    );
    expect(delta?.stopReason).toBe("tool_use");
  });

  it("passes the translated request to the runner — tools become a toolConfig", async () => {
    let captured: unknown;
    const a = adapter({
      runner: (input) => {
        captured = input;
        return replayRunner("openai-tool-use")();
      },
    });
    await collect(
      a.stream(
        request({
          model: "us.openai.gpt-5.6-sol",
          tools: [{ name: "read_file", input_schema: { type: "object" } }],
        }),
      ),
    );

    // The translation is what turns the loop's Anthropic-shaped request into Converse's shape;
    // a runner that received the untranslated request would fail against real Bedrock.
    expect((captured as { toolConfig?: unknown }).toolConfig).toBeDefined();
    expect((captured as { modelId?: string }).modelId).toBe("us.openai.gpt-5.6-sol");
  });
});

describe("live enumeration wiring", () => {
  // The injected path is exercised above; this just guards that the REAL path is only reached
  // when nothing is injected, so a test never silently hits AWS.
  it("uses the injected profile source when given one", async () => {
    const listProfiles = vi.fn(async () => [
      { id: "us.amazon.nova-lite-v1:0", displayName: "Nova" },
    ]);
    await adapter({ listProfiles }).listModels();
    expect(listProfiles).toHaveBeenCalledOnce();
  });
});
