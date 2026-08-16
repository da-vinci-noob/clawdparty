import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it } from "vitest";
import { SCENARIOS, loadCapture, replay, vocabulary } from "./converse_fixture.js";

/**
 * The captured ConverseStream transcripts, and the protocol facts the mapper has to be built
 * around.
 *
 * These are not tests of our code. They pin what BEDROCK sent, measured live against
 * `us.openai.gpt-5.6-sol` and `us.amazon.nova-lite-v1:0` in us-west-2 — because an earlier
 * version got this protocol wrong from reading documentation, and the fix came from running
 * one request. If a re-capture makes one of these fail, Bedrock changed and the mapper needs
 * revisiting; that is the signal this file exists to give.
 *
 * The captures also close the last unverified claim about streaming: it was only ever
 * *declared* supported (`responseStreamingSupported: true`) because aws-cli 2.36.14 has no
 * `converse-stream` subcommand. It is now executed.
 */

const kindsOf = (events: ConverseStreamOutput[]) => new Set(events.flatMap((e) => Object.keys(e)));

describe("every scenario was captured from a real stream", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario} has provenance and events`, () => {
      const capture = loadCapture(scenario);

      expect(capture.events.length).toBeGreaterThan(3);
      expect(capture.provenance.model_id).toMatch(/^us\.(openai|amazon)\./);
      expect(capture.provenance.region).toBe("us-west-2");
      // A fixture with no provenance is a fixture nobody can re-derive or date.
      expect(Date.parse(capture.provenance.captured_at)).not.toBeNaN();
    });
  }

  it("never records the AWS account id", () => {
    // The account behind a developer's SSO profile is infrastructure detail; a committed
    // fixture is the wrong place for it and the mapper does not need it.
    for (const scenario of SCENARIOS) {
      const raw = JSON.stringify(loadCapture(scenario));
      expect(raw).not.toMatch(/\b\d{12}\b/);
    }
  });
});

describe("the stream vocabulary the mapper must handle", () => {
  it("opens with messageStart and closes with messageStop then metadata", () => {
    for (const scenario of SCENARIOS) {
      const v = vocabulary(loadCapture(scenario).events);
      expect(v[0]).toBe("messageStart");
      expect(v.slice(-2)).toEqual(["messageStop", "metadata"]);
    }
  });

  it("sends NO contentBlockStart for text blocks — only for toolUse", () => {
    const text = loadCapture("nova-text").events;
    const starts = text.filter((e) => "contentBlockStart" in e);

    // The trap this pins: Anthropic's stream always sends a block_start, so a mapper written
    // from that habit would open a block on contentBlockStart and DROP every text delta on
    // Converse, silently producing empty assistant turns.
    expect(starts).toHaveLength(0);
    expect(kindsOf(text)).toContain("contentBlockDelta");
  });

  it("announces a tool call with contentBlockStart carrying id and name", () => {
    const start = loadCapture("openai-tool-use").events.find((e) => "contentBlockStart" in e) as
      | { contentBlockStart: { start?: { toolUse?: { toolUseId?: string; name?: string } } } }
      | undefined;

    expect(start?.contentBlockStart.start?.toolUse?.name).toBe("read_file");
    expect(start?.contentBlockStart.start?.toolUse?.toolUseId).toBeTruthy();
  });

  it("streams tool input as partial JSON fragments that only parse once concatenated", () => {
    const fragments = loadCapture("openai-tool-use")
      .events.flatMap((e) =>
        "contentBlockDelta" in e
          ? [
              (e as { contentBlockDelta: { delta?: { toolUse?: { input?: string } } } })
                .contentBlockDelta.delta?.toolUse?.input,
            ]
          : [],
      )
      .filter((f): f is string => typeof f === "string");

    expect(fragments.length).toBeGreaterThan(1);
    // Each fragment alone is not JSON — accumulate to contentBlockStop, then parse. Parsing
    // per delta would throw on the first one.
    expect(() => JSON.parse(fragments[0] as string)).toThrow();
    expect(JSON.parse(fragments.join(""))).toEqual({ path: "/tmp/notes.txt" });
  });

  it("carries usage on the metadata event, in Converse's own field names", () => {
    for (const scenario of SCENARIOS) {
      const meta = loadCapture(scenario).events.find((e) => "metadata" in e) as {
        metadata: { usage?: Record<string, number> };
      };
      const usage = meta.metadata.usage ?? {};

      // Usage accounting depends on this: `inputTokens`/`outputTokens`, NOT Anthropic's
      // `input_tokens`/`cache_read_input_tokens`. Reading the Anthropic names here yields
      // undefined, which would silently record a free turn.
      expect(usage).toHaveProperty("inputTokens");
      expect(usage).toHaveProperty("outputTokens");
      expect(usage).not.toHaveProperty("input_tokens");
    }
  });

  it("reports no cache fields at all, so prompt caching cannot be claimed", () => {
    const usage = (
      loadCapture("openai-text").events.find((e) => "metadata" in e) as {
        metadata: { usage?: Record<string, number> };
      }
    ).metadata.usage as Record<string, number>;

    expect(Object.keys(usage).some((k) => k.toLowerCase().includes("cache"))).toBe(false);
  });

  it("uses stop reasons the harness already understands", () => {
    const stop = (scenario: Parameters<typeof loadCapture>[0]) =>
      (
        loadCapture(scenario).events.find((e) => "messageStop" in e) as {
          messageStop: { stopReason?: string };
        }
      ).messageStop.stopReason;

    expect(stop("openai-text")).toBe("end_turn");
    expect(stop("nova-text")).toBe("end_turn");
    expect(stop("openai-tool-use")).toBe("tool_use");
    expect(stop("nova-tool-use")).toBe("tool_use");
    // Captured on purpose: `max_tokens` is a real terminal reason `loop/stop_reasons.ts`
    // decides on, and the first nova-text capture hit it accidentally at a 40-token budget —
    // which is how the fixtures ended up with no example of a NATURALLY completed turn.
    expect(stop("nova-max-tokens")).toBe("max_tokens");
  });
});

describe("reasoning content, which has two completely different shapes", () => {
  it("arrives from OpenAI as REDACTED BYTES that must never be displayed", () => {
    const delta = loadCapture("openai-text").events.find(
      (e) =>
        "contentBlockDelta" in e &&
        "reasoningContent" in
          ((e as { contentBlockDelta: { delta?: object } }).contentBlockDelta.delta ?? {}),
    ) as
      | { contentBlockDelta: { delta: { reasoningContent: { redactedContent?: Uint8Array } } } }
      | undefined;

    // A plain text turn opens with an encrypted reasoning block at index 0 and only then
    // sends the answer at index 1. Rendering these bytes as thinking would print binary at
    // the participant; dropping them may break multi-turn context, since this is the
    // provider's own carrier for reasoning state. `reasoning_carriers.test.ts` owns the decision.
    expect(delta).toBeDefined();
    expect(delta?.contentBlockDelta.delta.reasoningContent.redactedContent).toBeInstanceOf(
      Uint8Array,
    );
  });

  it("bills OpenAI's invisible reasoning against the SAME output budget as the answer", () => {
    const capture = loadCapture("openai-text");
    const usage = (
      capture.events.find((e) => "metadata" in e) as {
        metadata: { usage: { outputTokens: number } };
      }
    ).metadata.usage;
    const visible = capture.events
      .flatMap((e) =>
        "contentBlockDelta" in e
          ? [
              (e as { contentBlockDelta: { delta?: { text?: string } } }).contentBlockDelta.delta
                ?.text ?? "",
            ]
          : [],
      )
      .join("");

    // 38 output tokens for "Red, yellow, blue" — the rest went to reasoning nobody can see.
    // At maxTokens 40 this same prompt stopped with `max_tokens` before emitting ANY text, so
    // a budget tuned for Anthropic truncates these models into looking empty rather than
    // short. The adapter's capability table has to account for it.
    expect(usage.outputTokens).toBeGreaterThan(visible.length / 4);
    expect(visible.trim().length).toBeLessThan(30);
  });

  it("arrives from Nova as literal <thinking> markup inside an ORDINARY text block", () => {
    const text = loadCapture("nova-tool-use")
      .events.flatMap((e) =>
        "contentBlockDelta" in e
          ? [
              (e as { contentBlockDelta: { delta?: { text?: string } } }).contentBlockDelta.delta
                ?.text ?? "",
            ]
          : [],
      )
      .join("");

    // Indistinguishable from the answer at the protocol level: same block, same delta type.
    // Mapped naively, the participant reads "<thinking>I need to…</thinking>" as the reply.
    expect(text).toContain("<thinking");
  });
});

describe("the fixture can drive code that expects the SDK stream", () => {
  it("replays as an async iterable", async () => {
    const seen: string[] = [];
    for await (const event of replay("nova-text")) {
      seen.push(...Object.keys(event));
    }
    expect(seen[0]).toBe("messageStart");
    expect(seen.at(-1)).toBe("metadata");
  });
});
