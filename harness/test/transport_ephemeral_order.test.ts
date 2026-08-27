import type { EventEnvelope } from "@clawdparty/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Transport } from "../src/transport.js";

/**
 * streamed text reaches the room in the order it was produced.
 *
 * The defect this file exists for: `supervisor.ship()` sent every ephemeral delta as its own
 * unawaited POST, so N deltas raced and the browser concatenated them in ARRIVAL order. Real
 * words, wrong order, and fragments fused where a delta landed mid-word — "the so add a
 * contributions section" arriving as "a section so contributions add the". Reproduced against
 * this class with nothing more exotic than non-constant latency.
 *
 * The client cannot fix it: ephemeral events carry `seq: null` BY CONTRACT ("broadcast, never
 * persisted, so they carry no cursor"), so there is nothing to sort by. Order has to be a
 * property of delivery.
 *
 * `CLAUDE.md` also claimed deltas were "coalesced ~150ms in the harness". No coalescing code
 * existed, so concurrency was maximal — one request per token.
 */

const FLUSH_MS = 150;

function delta(text: string, over: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: null,
    session_id: "45",
    ai_run_id: "1",
    seq: null,
    type: "ai_text_delta",
    actor: { kind: "claude" },
    ts: "2026-08-16T00:00:00.000Z",
    payload: { block: "turn:0", text },
    ...over,
  } as EventEnvelope;
}

interface Harness {
  transport: Transport;
  /** Every event body Rails received, in the order it received them. */
  arrived: () => EventEnvelope[];
  /** How many HTTP requests were made — the coalescing measure. */
  requests: () => number;
}

/**
 * `latencies` cycles per request, so responses complete out of dispatch order. That is the
 * whole point: a transport that only works on a uniform-latency network is not ordered, it is
 * lucky.
 */
function harness(latencies: number[] = [30, 5, 20, 1, 12, 3]): Harness {
  const arrived: EventEnvelope[] = [];
  let requests = 0;

  const transport = new Transport({
    railsInternalUrl: "http://rails.test",
    sharedSecret: "s",
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    fetchImpl: async (_url, init) => {
      const n = requests++;
      const body = JSON.parse((init as { body: string }).body) as { events: EventEnvelope[] };
      const wait = latencies[n % latencies.length] as number;
      // Zero means NO timer at all, not setTimeout(0) — the fake-timer test needs the
      // coalescing window to be the only thing that can delay a delivery.
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      arrived.push(...body.events);
      return new Response("{}", { status: 200 });
    },
  });

  return { transport, arrived: () => arrived, requests: () => requests };
}

const textOf = (events: EventEnvelope[]) =>
  events.map((e) => (e.payload as { text?: string }).text ?? "").join("");

afterEach(() => vi.useRealTimers());

describe("ephemeral deltas arrive in emission order", () => {
  it("preserves order across VARYING latency", async () => {
    const h = harness();
    const words = ["The ", "so ", "add ", "a ", "contributions ", "section "];

    for (const w of words) void h.transport.deliverEphemeral(delta(w));
    await h.transport.flushEphemeral();

    // Before the fix this read "a section so contributions add The".
    expect(textOf(h.arrived())).toBe(words.join(""));
  });

  it("preserves order for a long stream, where a race is near-certain", async () => {
    const h = harness([25, 1, 18, 2, 9, 40, 3, 14]);
    const words = Array.from({ length: 40 }, (_unused, i) => `w${i} `);

    for (const w of words) void h.transport.deliverEphemeral(delta(w));
    await h.transport.flushEphemeral();

    expect(textOf(h.arrived())).toBe(words.join(""));
  });

  it("preserves order ACROSS BATCHES, not just within one", async () => {
    const h = harness([30, 2, 25, 1, 20, 3]);
    const words = ["one ", "two ", "three ", "four ", "five ", "six "];

    // Produce while a POST is outstanding — the production pattern, and the only way to get
    // several batches. Coalescing everything into ONE request would make the ordering tests
    // above pass without any serialization at all, so this is the test that pins it.
    for (const w of words) {
      void h.transport.deliverEphemeral(delta(w));
      void h.transport.flushEphemeral();
      await new Promise((r) => setTimeout(r, 4));
    }
    await h.transport.flushEphemeral();

    expect(h.requests()).toBeGreaterThan(1);
    expect(textOf(h.arrived())).toBe(words.join(""));
  });

  it("COALESCES a block's deltas instead of one request per token", async () => {
    const h = harness();

    for (let i = 0; i < 30; i++) void h.transport.deliverEphemeral(delta(`t${i} `));
    await h.transport.flushEphemeral();

    // 30 tokens must not be 30 HTTP requests. `CLAUDE.md` promised this and nothing
    // implemented it, which is what made the race maximal rather than occasional.
    expect(h.requests()).toBeLessThan(5);
    expect(textOf(h.arrived())).toBe(Array.from({ length: 30 }, (_unused, i) => `t${i} `).join(""));
  });
});

describe("coalescing merges only what may be merged", () => {
  it("keeps text and thinking deltas apart", async () => {
    const h = harness();

    void h.transport.deliverEphemeral(delta("visible "));
    void h.transport.deliverEphemeral(delta("hidden ", { type: "ai_thinking_delta" }));
    void h.transport.deliverEphemeral(delta("more visible"));
    await h.transport.flushEphemeral();

    // The store writes them to DIFFERENT fields (`textByBlock` / `thinkingByBlock`), so
    // merging them would put reasoning into the answer.
    const byType = new Map<string, string>();
    for (const e of h.arrived()) {
      byType.set(e.type, (byType.get(e.type) ?? "") + ((e.payload as { text: string }).text ?? ""));
    }
    expect(byType.get("ai_text_delta")).toBe("visible more visible");
    expect(byType.get("ai_thinking_delta")).toBe("hidden ");
  });

  it("keeps different blocks apart", async () => {
    const h = harness();

    void h.transport.deliverEphemeral(
      delta("block zero ", { payload: { block: "t:0", text: "block zero " } }),
    );
    void h.transport.deliverEphemeral(
      delta("block one", { payload: { block: "t:1", text: "block one" } }),
    );
    await h.transport.flushEphemeral();

    // The store accumulates by `(ai_run_id, block)`. Merging blocks would concatenate two
    // separate paragraphs into one.
    const blocks = h.arrived().map((e) => (e.payload as { block: string }).block);
    expect(new Set(blocks).size).toBe(2);
  });

  it("keeps different runs apart", async () => {
    const h = harness();

    void h.transport.deliverEphemeral(delta("run one "));
    void h.transport.deliverEphemeral(delta("run two", { ai_run_id: "2" }));
    await h.transport.flushEphemeral();

    expect(new Set(h.arrived().map((e) => e.ai_run_id)).size).toBe(2);
  });

  it("does NOT coalesce whole-value ephemerals like context_usage", async () => {
    const h = harness();

    void h.transport.deliverEphemeral(
      delta("", { type: "context_usage", payload: { input: 10, window: 1000 } }),
    );
    void h.transport.deliverEphemeral(
      delta("", { type: "context_usage", payload: { input: 20, window: 1000 } }),
    );
    await h.transport.flushEphemeral();

    // These replace rather than accumulate — the latest reading is the truth. Concatenating
    // them is meaningless, and dropping the earlier one would be a different decision than
    // this transport is entitled to make.
    expect(h.arrived()).toHaveLength(2);
    expect((h.arrived()[1]?.payload as { input: number }).input).toBe(20);
  });
});

describe("it stays best-effort", () => {
  it("swallows a delivery failure rather than failing the run", async () => {
    const transport = new Transport({
      railsInternalUrl: "http://rails.test",
      sharedSecret: "s",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });

    // A dropped ephemeral is acceptable — `ai_text` at block stop is the durable record.
    // Throwing here would take down a run over a cosmetic delivery.
    void transport.deliverEphemeral(delta("lost "));
    await expect(transport.flushEphemeral()).resolves.toBeUndefined();
  });

  it("never buffers an ephemeral for retry", async () => {
    const h = harness();

    void h.transport.deliverEphemeral(delta("x "));
    await h.transport.flushEphemeral();

    // The durable ring buffer is for durable events. A retried delta would arrive after the
    // block it belongs to had already settled.
    expect(h.transport.bufferLength).toBe(0);
  });

  it("leaves no timer pending once drained", async () => {
    vi.useFakeTimers();
    const h = harness([0]);

    void h.transport.deliverEphemeral(delta("x "));
    await h.transport.flushEphemeral();

    // A flush that cancelled nothing would leave the window timer armed, and the next
    // enqueue would see one already set and never arm its own — deltas would then sit in
    // the queue until something else happened to flush.
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});

describe("the flush timer", () => {
  it("ships without an explicit flush, within the coalescing window", async () => {
    vi.useFakeTimers();
    const h = harness([0]);

    void h.transport.deliverEphemeral(delta("auto "));
    expect(h.arrived()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(FLUSH_MS + 10);

    // Production never calls flushEphemeral: the timer is what delivers. A test that only
    // exercised the explicit flush would pass against a transport that never ships at all.
    expect(textOf(h.arrived())).toBe("auto ");
    vi.useRealTimers();
  });
});
