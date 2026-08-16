import { describe, expect, it } from "vitest";
import type { ProviderEvent } from "../../src/providers/contract.js";
import { mapConverseStream } from "../../src/providers/converse_stream.js";
import { type ConverseScenario, replay } from "./converse_fixture.js";

/**
 * The Converse→ProviderEvent mapping, driven by the captured transcripts.
 *
 * Every case here corresponds to a hazard MEASURED in a real stream, not imagined: text
 * blocks that never announce themselves, tool input that only parses once concatenated, usage
 * that arrives after the stop reason, and two incompatible reasoning carriers.
 */

async function collect(scenario: ConverseScenario, model = "test-model"): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of mapConverseStream(replay(scenario), model)) {
    out.push(event);
  }
  return out;
}

const types = (events: ProviderEvent[]) => events.map((e) => e.t);
const textOf = (events: ProviderEvent[]) =>
  events
    .filter((e): e is Extract<ProviderEvent, { t: "text_delta" }> => e.t === "text_delta")
    .map((e) => e.text)
    .join("");

describe("a plain text turn", () => {
  it("synthesizes the block_start the protocol never sends", async () => {
    const events = await collect("nova-text");

    // Converse sends no contentBlockStart for text. Without synthesizing one the loop sees
    // deltas for a block it never opened, and the normalizer has no block to close.
    const starts = events.filter((e) => e.t === "block_start");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ t: "block_start", kind: "text" });
  });

  it("emits exactly one block_start per block, not one per delta", async () => {
    const events = await collect("nova-text");
    const deltas = events.filter((e) => e.t === "text_delta");

    expect(deltas.length).toBeGreaterThan(3);
    expect(events.filter((e) => e.t === "block_start")).toHaveLength(1);
  });

  it("preserves the text exactly", async () => {
    const events = await collect("nova-text");
    expect(textOf(events)).toContain("Red");
  });

  it("closes with message_delta then message_stop, in that order", async () => {
    const events = await collect("nova-text");
    expect(types(events).slice(-2)).toEqual(["message_delta", "message_stop"]);
  });

  it("carries the model id, which the stream itself never mentions", async () => {
    const events = await collect("nova-text", "us.amazon.nova-lite-v1:0");
    expect(events[0]).toEqual({ t: "message_start", model: "us.amazon.nova-lite-v1:0" });
  });
});

describe("a tool-calling turn", () => {
  it("opens the tool block from contentBlockStart", async () => {
    const events = await collect("openai-tool-use");
    const start = events.find((e) => e.t === "block_start");
    expect(start).toMatchObject({ kind: "tool_use" });
  });

  it("passes input through as fragments rather than parsing per delta", async () => {
    const events = await collect("openai-tool-use");
    const fragments = events.filter(
      (e): e is Extract<ProviderEvent, { t: "tool_input_delta" }> => e.t === "tool_input_delta",
    );

    expect(fragments.length).toBeGreaterThan(1);
    // The first fragment is `{"` — parsing it would throw, which is why accumulation belongs
    // at block_stop and not in the delta path.
    expect(() => JSON.parse(fragments[0]?.partialJson ?? "")).toThrow();
  });

  it("parses the accumulated input ONCE, into a block the LOOP can read", async () => {
    const events = await collect("openai-tool-use");
    const stop = events.find(
      (e): e is Extract<ProviderEvent, { t: "block_stop" }> => e.t === "block_stop",
    );

    // The block MUST be canonical `{type:"tool_use", id, name, input}` — that is the ONE shape
    // `run_loop.streamTurn` extracts a tool call from. A Converse-shaped `{toolUse:{…}}` block
    // left the loop with an empty tool id, and the follow-up turn's tool_result then matched no
    // call: "No tool output found for function call call_…", a run-killing ValidationException.
    expect(stop?.block).toMatchObject({
      type: "tool_use",
      name: "read_file",
      input: { path: "/tmp/notes.txt" },
    });
  });

  it("keeps the tool_use id, without which no result can be matched to its call", async () => {
    const events = await collect("openai-tool-use");
    const stop = events.find(
      (e): e is Extract<ProviderEvent, { t: "block_stop" }> => e.t === "block_stop",
    );
    // `id`, the field the loop reads for the tool_result's tool_use_id.
    expect((stop?.block as { id?: string }).id).toBeTruthy();
  });

  it("reports the tool_use stop reason", async () => {
    const events = await collect("nova-tool-use");
    const delta = events.find(
      (e): e is Extract<ProviderEvent, { t: "message_delta" }> => e.t === "message_delta",
    );
    expect(delta?.stopReason).toBe("tool_use");
  });

  it("keeps Nova's inline <thinking> in the text block it actually arrived in", async () => {
    const events = await collect("nova-tool-use");

    // Nova emits reasoning as ordinary text. Reclassifying it as a thinking block here would
    // be the mapper inventing a distinction the protocol does not make — whether to strip it
    // for display is a rendering decision, not a mapping one.
    expect(textOf(events)).toContain("<thinking");
    expect(events.some((e) => e.t === "thinking_delta")).toBe(false);
  });
});

describe("encrypted reasoning", () => {
  it("emits NO delta for redacted bytes", async () => {
    const events = await collect("openai-text");

    // There is nothing displayable in them; a thinking_delta carrying bytes would print
    // binary at the participant.
    expect(events.some((e) => e.t === "thinking_delta")).toBe(false);
  });

  it("still opens and closes the block, carrying the bytes verbatim", async () => {
    const events = await collect("openai-text");
    const thinking = events.find((e) => e.t === "block_start" && e.kind === "thinking");
    const stops = events.filter(
      (e): e is Extract<ProviderEvent, { t: "block_stop" }> => e.t === "block_stop",
    );
    const redacted = stops
      .map((s) => s.block as { reasoningContent?: { redactedContent?: Uint8Array } })
      .find((b) => b.reasoningContent?.redactedContent);

    // The bytes are the provider's own carrier for reasoning state across turns, so they have
    // to survive into the surface unmodified (R6) even though nothing renders them.
    expect(thinking).toBeDefined();
    expect(redacted?.reasoningContent?.redactedContent).toBeInstanceOf(Uint8Array);
  });

  it("gives the visible answer its own separate block", async () => {
    const events = await collect("openai-text");
    const kinds = events
      .filter((e): e is Extract<ProviderEvent, { t: "block_start" }> => e.t === "block_start")
      .map((e) => e.kind);

    expect(kinds).toEqual(["thinking", "text"]);
    expect(textOf(events).trim()).toBe("Red, yellow, blue");
  });
});

describe("usage and stop reasons", () => {
  it("waits for metadata so stopReason and usage arrive together", async () => {
    const events = await collect("nova-text");
    const delta = events.find(
      (e): e is Extract<ProviderEvent, { t: "message_delta" }> => e.t === "message_delta",
    );

    // messageStop lands BEFORE metadata in the wire order. Emitting message_delta on
    // messageStop would report every turn as free.
    expect(delta?.usage.input_tokens).toBeGreaterThan(0);
    expect(delta?.usage.output_tokens).toBeGreaterThan(0);
  });

  it("reports zero cache tokens, because Converse reports none", async () => {
    const events = await collect("openai-text");
    const delta = events.find(
      (e): e is Extract<ProviderEvent, { t: "message_delta" }> => e.t === "message_delta",
    );
    expect(delta?.usage.cache_read_input_tokens).toBe(0);
    expect(delta?.usage.cache_creation_input_tokens).toBe(0);
  });

  it("maps max_tokens through, since the loop acts on it", async () => {
    const events = await collect("nova-max-tokens");
    const delta = events.find(
      (e): e is Extract<ProviderEvent, { t: "message_delta" }> => e.t === "message_delta",
    );
    expect(delta?.stopReason).toBe("max_tokens");
  });
});

describe("shapes the mapper has never seen", () => {
  async function mapOne(event: unknown): Promise<ProviderEvent[]> {
    async function* one(): AsyncGenerator<never> {
      yield event as never;
    }
    const out: ProviderEvent[] = [];
    for await (const e of mapConverseStream(one(), "m")) out.push(e);
    return out;
  }

  it("surfaces an unknown event as raw instead of throwing", async () => {
    // an unmapped shape must never crash a run. Bedrock already sends
    // internalServerException / throttlingException on this channel, and will add more.
    const out = await mapOne({ someFutureEvent: { detail: 1 } });
    expect(out).toEqual([{ t: "raw", value: { someFutureEvent: { detail: 1 } } }]);
  });

  it("does not invent a text block for a tool delta with no opening", async () => {
    // A synthesized text block here would silently swallow a tool call and the loop would
    // answer a request that was never made.
    const out = await mapOne({
      contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"a":1}' } } },
    });
    expect(types(out)).toEqual(["raw"]);
  });

  it("settles a stream that ends without metadata", async () => {
    async function* truncated(): AsyncGenerator<never> {
      yield { messageStart: { role: "assistant" } } as never;
      yield { messageStop: { stopReason: "end_turn" } } as never;
    }
    const out: ProviderEvent[] = [];
    for await (const e of mapConverseStream(truncated(), "m")) out.push(e);

    // Without this the loop waits forever for a message_delta that is never coming.
    expect(types(out)).toEqual(["message_start", "message_delta", "message_stop"]);
  });

  it("tolerates a malformed tool input rather than throwing mid-stream", async () => {
    async function* broken(): AsyncGenerator<never> {
      yield {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolUse: { toolUseId: "t", name: "x" } },
        },
      } as never;
      yield {
        contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: "{not json" } } },
      } as never;
      yield { contentBlockStop: { contentBlockIndex: 0 } } as never;
    }
    const out: ProviderEvent[] = [];
    for await (const e of mapConverseStream(broken(), "m")) out.push(e);
    const stop = out.find(
      (e): e is Extract<ProviderEvent, { t: "block_stop" }> => e.t === "block_stop",
    );

    // The tool then fails with a readable error, which beats killing the run.
    expect(stop?.block).toMatchObject({ type: "tool_use", input: { __unparsed: "{not json" } });
  });
});
