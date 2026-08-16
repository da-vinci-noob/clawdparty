import { describe, expect, it } from "vitest";
import type { ProviderEvent, ProviderRequest } from "../../src/providers/contract.js";
import { toConverseInput } from "../../src/providers/converse_request.js";
import { mapConverseStream } from "../../src/providers/converse_stream.js";
import { type ConverseScenario, replay } from "./converse_fixture.js";

/**
 * The three reasoning carriers, and the one decision each.
 *
 * Bedrock Converse carries reasoning three incompatible ways, and each one needs a different
 * answer. Every rule below was MEASURED against live models, because two of them are the
 * opposite of what the shapes suggest:
 *
 *   | carrier                       | model    | display              | echo back on turn 2      |
 *   |-------------------------------|----------|----------------------|--------------------------|
 *   | reasoningContent.text         | DeepSeek | ai_thinking          | NO — Bedrock REJECTS it  |
 *   | reasoningContent.redacted     | OpenAI   | nothing (encrypted)  | YES — accepted           |
 *   | literal <thinking> in text    | Nova     | web segments it       | as ordinary text         |
 *
 * The two echo rules INVERT the intuitive reading. Plaintext reasoning looks echoable and is
 * refused — `ValidationException: User messages cannot contain reasoning content.` from
 * `us.deepseek.r1-v1:0`, measured against a text-only control turn that succeeded. Encrypted
 * bytes look unechoable and are accepted; the same probe showed the echoing turn emitting NO
 * new reasoning while the control re-derived 776 bytes of it, which is the whole point of the
 * carrier.
 *
 * Nova's is not a protocol carrier at all — `<thinking>…</thinking>` inside an ordinary text
 * block, indistinguishable from the answer at this layer — so the mapper leaves it alone and
 * the web segments it at render (`web/src/helpers/reasoning_tags.ts`).
 */

const signal = new AbortController().signal;

async function collect(scenario: ConverseScenario): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of mapConverseStream(replay(scenario), "test-model")) {
    out.push(event);
  }
  return out;
}

const blocksOf = (events: ProviderEvent[]): unknown[] =>
  events
    .filter((e): e is Extract<ProviderEvent, { t: "block_stop" }> => e.t === "block_stop")
    .map((e) => e.block);

/** What the session store does to a verbatim block: JSON on write, JSON on read. */
const throughStore = (block: unknown): unknown => JSON.parse(JSON.stringify(block));

function req(messages: ProviderRequest["messages"]): ProviderRequest {
  return {
    model: "us.openai.gpt-5.6-sol",
    maxTokens: 1024,
    system: [{ type: "text", text: "You are a test." }],
    messages,
    tools: [],
    cacheBreakpoints: [],
    signal,
  };
}

const contentOf = (input: { messages?: unknown[] }, at = 0): unknown[] =>
  (input.messages as Array<{ content?: unknown[] }> | undefined)?.[at]?.content ?? [];

describe("carrier 1: plaintext reasoningContent.text (DeepSeek R1)", () => {
  it("streams as thinking, so the participant sees the reasoning as reasoning", async () => {
    const events = await collect("deepseek-reasoning");
    const thinking = events
      .filter((e): e is Extract<ProviderEvent, { t: "thinking_delta" }> => e.t === "thinking_delta")
      .map((e) => e.text)
      .join("");

    expect(thinking.length).toBeGreaterThan(100);
    expect(thinking).toContain("17");
  });

  it("puts the ANSWER in its own text block, which is not what was assumed", async () => {
    // An earlier note recorded R1 as answering "with an empty first text block" — it does not. Block 0
    // is reasoning and block 1 is the answer; the earlier reading mistook index 0 for the
    // answer. R1 renders correctly with no special handling at all.
    const events = await collect("deepseek-reasoning");
    const kinds = events
      .filter((e): e is Extract<ProviderEvent, { t: "block_start" }> => e.t === "block_start")
      .map((e) => e.kind);
    const text = events
      .filter((e): e is Extract<ProviderEvent, { t: "text_delta" }> => e.t === "text_delta")
      .map((e) => e.text)
      .join("");

    expect(kinds).toEqual(["thinking", "text"]);
    expect(text.trim()).toBe("51");
  });

  it("is NOT echoed back — Bedrock rejects an assistant turn carrying reasoning text", () => {
    // Measured on us.deepseek.r1-v1:0: echoing this block back fails the whole request with
    // "User messages cannot contain reasoning content", while the identical turn without it
    // answers. Sending it would break the SECOND turn of every plaintext-reasoning model.
    const input = toConverseInput(
      req([
        {
          role: "assistant",
          content: [
            { reasoningContent: { reasoningText: { text: "let me think" } } },
            { text: "51" },
          ],
        },
      ]),
    );

    expect(contentOf(input)).toEqual([{ text: "51" }]);
  });
});

describe("carrier 2: encrypted redactedContent (OpenAI)", () => {
  it("emits no delta — there is nothing displayable in encrypted bytes", async () => {
    const events = await collect("openai-text");
    expect(events.some((e) => e.t === "thinking_delta")).toBe(false);
  });

  it("survives the store as BYTES, not as a numeric-key object", async () => {
    // `JSON.stringify(new Uint8Array([114,115]))` is `{"0":114,"1":115}` — 8,084 bytes per turn
    // for this fixture, and a shape the SDK never produces, so it could not be echoed and was
    // dropped. Tagged base64 round-trips (1.2KB) and rehydrates.
    const stored = throughStore(blocksOf(await collect("openai-text"))[0]) as {
      reasoningContent?: { redactedContent?: { __bytes_b64?: string } };
    };

    expect(stored.reasoningContent?.redactedContent?.__bytes_b64).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("is echoed back as real bytes, so the model does not re-derive its reasoning", async () => {
    const stored = throughStore(blocksOf(await collect("openai-text"))[0]);
    const input = toConverseInput(
      req([{ role: "assistant", content: [stored, { text: "answer" }] }]),
    );

    const echoed = contentOf(input)[0] as { reasoningContent?: { redactedContent?: unknown } };
    expect(echoed.reasoningContent?.redactedContent).toBeInstanceOf(Uint8Array);
    expect((echoed.reasoningContent?.redactedContent as Uint8Array).length).toBeGreaterThan(100);
  });

  it("drops the legacy numeric-key shape already sitting in existing stores", () => {
    // Sessions that ran before this change hold `{"0":114,…}` on their surface. Rehydrating it
    // would be guesswork about a truncated encoding; Bedrock rejects a malformed
    // reasoningContent, so the old shape is dropped and the turn still runs.
    const input = toConverseInput(
      req([
        {
          role: "assistant",
          content: [{ reasoningContent: { redactedContent: { 0: 114, 1: 115 } } }, { text: "hi" }],
        },
      ]),
    );

    expect(contentOf(input)).toEqual([{ text: "hi" }]);
  });

  it("drops bytes that are not decodable rather than sending a malformed block", () => {
    const input = toConverseInput(
      req([
        {
          role: "assistant",
          content: [{ reasoningContent: { redactedContent: { __bytes_b64: "" } } }, { text: "hi" }],
        },
      ]),
    );

    expect(contentOf(input)).toEqual([{ text: "hi" }]);
  });
});

describe("carrier 3: Nova's literal <thinking> inside ordinary text", () => {
  it("stays in the text block, unreclassified — this layer cannot tell it from the answer", async () => {
    const events = await collect("nova-tool-use");
    const text = events
      .filter((e): e is Extract<ProviderEvent, { t: "text_delta" }> => e.t === "text_delta")
      .map((e) => e.text)
      .join("");

    // Reclassifying here would also be impossible mid-stream: the tag arrives split across
    // deltas that were already broadcast, and an ephemeral delta cannot be retracted.
    expect(text).toContain("<thinking>");
    expect(events.some((e) => e.t === "thinking_delta")).toBe(false);
  });
});
