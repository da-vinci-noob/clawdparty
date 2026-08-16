import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicDirectAdapter } from "../../src/providers/anthropic_direct.js";
import type { ProviderEvent } from "../../src/providers/contract.js";
import {
  type CapturedRequest,
  type ConformanceHarness,
  KNOWN_TEST_SECRET,
  conformanceRequest,
  runConformanceSuite,
} from "./conformance.js";

/**
 * Gate 4 against the reference adapter. The vendor client is faked at the SDK
 * boundary — the adapter's own mapping is what is under test, and faking any
 * lower would test the fake instead.
 */

const TEXT_BLOCK = { type: "text", text: "hello there", citations: null };
const THINKING_BLOCK = { type: "thinking", thinking: "considering", signature: "sig-abc" };
const TOOL_BLOCK = { type: "tool_use", id: "toolu_01", name: "bash", input: { command: "ls" } };

const MODEL_LIST = {
  data: [
    {
      id: "claude-opus-5",
      display_name: "Claude Opus 5",
      type: "model" as const,
      created_at: "2026-01-01T00:00:00Z",
      max_input_tokens: 1_000_000,
      max_tokens: 64_000,
      capabilities: {
        batch: { supported: true },
        citations: { supported: true },
        code_execution: { supported: true },
        context_management: {
          clear_thinking_20251015: { supported: true },
          clear_tool_uses_20250919: { supported: true },
        },
        effort: {
          low: { supported: true },
          medium: { supported: true },
          high: { supported: true },
          xhigh: { supported: true },
          max: { supported: true },
        },
        image_input: { supported: true },
        pdf_input: { supported: true },
        structured_outputs: { supported: true },
        thinking: {
          supported: true,
          types: { adaptive: { supported: true }, enabled: { supported: false } },
        },
      },
    },
  ],
};

type StreamEvent = Record<string, unknown>;

function lifecycle(blocks: unknown[], stopReason: string): StreamEvent[] {
  const events: StreamEvent[] = [{ type: "message_start", message: { model: "claude-opus-5" } }];
  blocks.forEach((block, index) => {
    events.push({ type: "content_block_start", index, content_block: block });
    const b = block as { type: string; text?: string; thinking?: string };
    if (b.type === "text") {
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: b.text },
      });
    } else if (b.type === "thinking") {
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: b.thinking },
      });
      // signature_delta carries no harness-visible text; it rides inside the block.
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: "sig-abc" },
      });
    } else {
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' },
      });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({
    type: "message_delta",
    delta: { stop_reason: stopReason },
    usage: {
      input_tokens: 12,
      output_tokens: 34,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 6,
    },
  });
  events.push({ type: "message_stop" });
  return events;
}

interface FakeOptions {
  events: StreamEvent[];
  blocks: unknown[];
  /** Stop yielding after N events, simulating an abort. */
  cutAfter?: number;
  listThrows?: { status: number } | Error;
}

function fakeClient(options: FakeOptions, captured: CapturedRequest[]): Anthropic {
  const client = {
    models: {
      list: async () => {
        if (options.listThrows) throw options.listThrows;
        return MODEL_LIST;
      },
    },
    messages: {
      stream: (body: Record<string, unknown>) => {
        captured.push({
          body,
          url: "https://api.anthropic.com/v1/messages",
          headers: {
            "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
            "content-type": "application/json",
          },
        });
        const handle = {
          currentMessage: { content: [] as unknown[] },
          async *[Symbol.asyncIterator]() {
            let emitted = 0;
            for (const event of options.events) {
              if (options.cutAfter !== undefined && emitted >= options.cutAfter) return;
              // Mirror the SDK: currentMessage accumulates as blocks complete, so
              // content[index] is populated by the time content_block_stop is seen.
              if (event.type === "content_block_start") {
                handle.currentMessage.content[event.index as number] =
                  options.blocks[event.index as number];
              }
              emitted += 1;
              yield event;
            }
          },
        };
        return handle;
      },
    },
  };
  return client as unknown as Anthropic;
}

async function collect(iterable: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

function harness(): ConformanceHarness {
  const captured: CapturedRequest[] = [];
  const blocks = [THINKING_BLOCK, TEXT_BLOCK, TOOL_BLOCK];

  const build = (opts: Partial<FakeOptions> = {}) =>
    new AnthropicDirectAdapter({
      client: fakeClient({ events: lifecycle(blocks, "tool_use"), blocks, ...opts }, captured),
      discovery: { source: "env:ANTHROPIC_API_KEY", usable: true },
    });

  const adapter = build();

  return {
    adapter,
    async minimalTurn() {
      const textOnly = [TEXT_BLOCK];
      const a = new AnthropicDirectAdapter({
        client: fakeClient({ events: lifecycle(textOnly, "end_turn"), blocks: textOnly }, captured),
        discovery: { source: "env:ANTHROPIC_API_KEY", usable: true },
      });
      return collect(a.stream(conformanceRequest()));
    },
    async toolUseTurn() {
      await adapter.listModels();
      return collect(adapter.stream(conformanceRequest()));
    },
    vendorBlocks() {
      return blocks;
    },
    captured() {
      return captured;
    },
    withoutCredential() {
      return new AnthropicDirectAdapter({
        client: fakeClient({ events: [], blocks: [] }, captured),
        discovery: {
          source: "none",
          usable: false,
          problem: "no Anthropic credential found",
          remedy: "Run `claude setup-token`, or export ANTHROPIC_API_KEY, or run `ant auth login`.",
        },
      });
    },
    async unknownShapeTurn() {
      const a = build({ events: [{ type: "some_future_event_type", payload: 1 }] });
      return collect(a.stream(conformanceRequest()));
    },
    async abortMidStream() {
      // Cut immediately after the first block closes: message_start,
      // content_block_start, delta, signature delta, content_block_stop = 5.
      const a = build({ events: lifecycle(blocks, "tool_use"), cutAfter: 5 });
      return collect(a.stream(conformanceRequest()));
    },
    diskWrites() {
      return [];
    },
    allowedHosts() {
      // First-party only. A Bedrock adapter would declare its regional host here,
      // and declaring the wrong one is what assertion 11 catches.
      return ["api.anthropic.com"];
    },
  };
}

describe("anthropic-direct — adapter conformance (gate 4)", () => {
  runConformanceSuite({
    name: "anthropic-direct",
    build: harness,
    models: ["claude-opus-5"],
  });
});

describe("anthropic-direct — mapping specifics", () => {
  it("maps thinking and text deltas to distinct harness events", async () => {
    const events = await harness().toolUseTurn();

    expect(events.filter((e) => e.t === "thinking_delta")).toHaveLength(1);
    expect(events.filter((e) => e.t === "text_delta")).toHaveLength(1);
    expect(events.filter((e) => e.t === "tool_input_delta")).toHaveLength(1);
  });

  it("classifies a redacted thinking block as thinking, not tool_use", async () => {
    const blocks = [{ type: "redacted_thinking", data: "opaque" }];
    const captured: CapturedRequest[] = [];
    const adapter = new AnthropicDirectAdapter({
      client: fakeClient({ events: lifecycle(blocks, "end_turn"), blocks }, captured),
      discovery: { source: "env:ANTHROPIC_API_KEY", usable: true },
    });

    const starts = (await collect(adapter.stream(conformanceRequest()))).filter(
      (e): e is Extract<ProviderEvent, { t: "block_start" }> => e.t === "block_start",
    );
    expect(starts[0]?.kind).toBe("thinking");
  });

  it("maps stop_sequence to end_turn — the loop has no separate notion of it", async () => {
    const blocks = [TEXT_BLOCK];
    const adapter = new AnthropicDirectAdapter({
      client: fakeClient({ events: lifecycle(blocks, "stop_sequence"), blocks }, []),
      discovery: { source: "env:ANTHROPIC_API_KEY", usable: true },
    });

    const events = await collect(adapter.stream(conformanceRequest()));
    expect(events.find((e) => e.t === "message_delta")).toMatchObject({ stopReason: "end_turn" });
  });

  it("reports real per-model budgets from the Models API, not constants", async () => {
    const h = harness();
    const models = await h.adapter.listModels();

    expect(models[0]).toMatchObject({ id: "claude-opus-5", displayName: "Claude Opus 5" });
    expect(models[0]?.capabilities.contextWindow).toBe(1_000_000);
    expect(models[0]?.capabilities.maxOutputTokens).toBe(64_000);
    expect(models[0]?.capabilities.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("falls back conservatively for a model the Models API did not list", () => {
    // Over-declaring would send requests that 400 and surface as a provider error
    // rather than as an unsupported capability.
    const caps = harness().adapter.capabilities("some-unlisted-model");

    expect(caps.serverSideTools).toEqual({
      webSearch: false,
      webFetch: false,
      codeExecution: false,
    });
    expect(caps.effortLevels).toEqual([]);
    expect(caps.promptCaching).toBe(false);
  });

  it("declares web search and fetch, which the Models API does not report", async () => {
    // The gap this covers: capabilities() must be total, but the Models API is
    // silent on web tools and prompt caching, so those come from the adapter's
    // declared set. A provider without them (Bedrock) differs in one place.
    const h = harness();
    await h.adapter.listModels();

    expect(h.adapter.capabilities("claude-opus-5").serverSideTools).toEqual({
      webSearch: true,
      webFetch: true,
      codeExecution: true,
    });
  });

  it("probe() surfaces 401 as an expired credential with a specific remedy", async () => {
    const adapter = new AnthropicDirectAdapter({
      client: fakeClient({ events: [], blocks: [], listThrows: { status: 401 } }, []),
      discovery: { source: "env:ANTHROPIC_API_KEY", usable: true },
    });

    const result = await adapter.probe();
    expect(result).toMatchObject({ available: false, reason: "credential_expired" });
    if (result.available) throw new Error("expected unavailable");
    expect(result.remedy).toMatch(/401/);
  });

  it("probe() distinguishes 403 not-entitled from a rejected credential", async () => {
    const adapter = new AnthropicDirectAdapter({
      client: fakeClient({ events: [], blocks: [], listThrows: { status: 403 } }, []),
      discovery: { source: "env:ANTHROPIC_API_KEY", usable: true },
    });

    expect(await adapter.probe()).toMatchObject({ available: false, reason: "not_entitled" });
  });

  it("records the credential source as an identity and never the value", async () => {
    process.env.ANTHROPIC_API_KEY = KNOWN_TEST_SECRET;
    try {
      const adapter = new AnthropicDirectAdapter({
        client: fakeClient({ events: [], blocks: [] }, []),
        discovery: { source: "env:ANTHROPIC_API_KEY", usable: true },
      });

      const result = await adapter.probe();
      expect(result).toMatchObject({
        available: true,
        credentialSource: "env:ANTHROPIC_API_KEY",
      });
      expect(JSON.stringify(result)).not.toContain(KNOWN_TEST_SECRET);
    } finally {
      process.env.ANTHROPIC_API_KEY = undefined;
    }
  });

  it("never emits a removed parameter, even when effort and thinking are set", async () => {
    const captured: CapturedRequest[] = [];
    const blocks = [TEXT_BLOCK];
    const adapter = new AnthropicDirectAdapter({
      client: fakeClient({ events: lifecycle(blocks, "end_turn"), blocks }, captured),
      discovery: { source: "env:ANTHROPIC_API_KEY", usable: true },
    });

    await collect(adapter.stream(conformanceRequest({ effort: "high" })));

    const body = JSON.stringify(captured.at(-1)?.body);
    expect(body).toContain('"effort":"high"');
    expect(body).toContain('"adaptive"');
    for (const removed of ["temperature", "top_p", "top_k", "budget_tokens"]) {
      expect(body).not.toContain(`"${removed}"`);
    }
  });
});
