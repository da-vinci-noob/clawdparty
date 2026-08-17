import { describe, expect, it } from "vitest";
import { mapAnthropicStream } from "../../src/providers/anthropic_family.js";
import type { ProviderEvent } from "../../src/providers/contract.js";

/**
 * Input tokens are reported WHEREVER the stream puts them.
 *
 * Measured on Bedrock, and the two models disagree:
 *
 *   opus-4-1     message_start {input_tokens:10, cache_*:0, output_tokens:3}
 *                message_delta {output_tokens:11}                  ← input NOT repeated
 *   sonnet-4-6   message_start {input_tokens:10, ...}
 *                message_delta {input_tokens:10, cache_*:0, output_tokens:25}
 *
 * The mapper read usage from `message_delta` ALONE, so every model of the first kind recorded
 * `input_tokens: 0` — and the web's CONTEXT bar divides that by the window, so it displayed a
 * session with 2,000 tokens of history as using none. It looked correct on newer models, which is
 * why it survived: the earlier verification happened to use one that repeats the field.
 *
 * Zero is not a missing value here; it is a claim. The same rule as `total_cost_usd` (1.7.0): a
 * figure the provider did report must not be recorded as nothing.
 */

interface RawEvent {
  type: string;
  [key: string]: unknown;
}

async function* replay(events: RawEvent[]): AsyncIterable<RawEvent> {
  for (const event of events) yield event;
}

async function collect(events: RawEvent[]): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  // The mapper takes the SDK's stream shape; `currentMessage` is only read at block_stop.
  const stream = Object.assign(replay(events), { currentMessage: { content: [] } });
  for await (const mapped of mapAnthropicStream(stream as never)) out.push(mapped);
  return out;
}

const usageOf = (events: ProviderEvent[]) =>
  events.find((e): e is Extract<ProviderEvent, { t: "message_delta" }> => e.t === "message_delta")
    ?.usage;

describe("a stream that reports input tokens ONLY on message_start (opus-4-1)", () => {
  const events: RawEvent[] = [
    {
      type: "message_start",
      message: {
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 2,
          output_tokens: 3,
        },
      },
    },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 11 } },
    { type: "message_stop" },
  ];

  it("keeps the input tokens the provider reported", async () => {
    expect(usageOf(await collect(events))?.input_tokens).toBe(10);
  });

  it("keeps the cache fields too, which ride on the same event", async () => {
    const usage = usageOf(await collect(events));
    expect(usage?.cache_read_input_tokens).toBe(4);
    expect(usage?.cache_creation_input_tokens).toBe(2);
  });

  it("takes the FINAL output count from message_delta, not the opening one", async () => {
    // `message_start` carries an output figure too, and it is the count so far — 3, not 11.
    expect(usageOf(await collect(events))?.output_tokens).toBe(11);
  });
});

describe("a stream that repeats usage on message_delta (sonnet-4-6)", () => {
  it("prefers the delta, which is the later and more complete figure", async () => {
    const usage = usageOf(
      await collect([
        { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 12, cache_read_input_tokens: 5, output_tokens: 25 },
        },
        { type: "message_stop" },
      ]),
    );

    expect(usage).toMatchObject({
      input_tokens: 12,
      cache_read_input_tokens: 5,
      output_tokens: 25,
    });
  });
});

describe("a stream that reports no usage at all", () => {
  it("reports zeros rather than throwing", async () => {
    const usage = usageOf(
      await collect([
        { type: "message_start", message: {} },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
      ]),
    );

    expect(usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });
});
