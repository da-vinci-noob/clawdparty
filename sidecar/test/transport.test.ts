import type { EventEnvelope } from "@clawdparty/contracts";
import { describe, expect, it, vi } from "vitest";
import { Transport } from "../src/transport.js";

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function durable(seq: number): EventEnvelope {
  return {
    id: null,
    session_id: "sess_1",
    ai_run_id: "run_1",
    seq,
    type: "ai_text",
    actor: { kind: "claude" },
    ts: "2026-06-28T20:11:05.123Z",
    payload: {},
  };
}

function ephemeral(): EventEnvelope {
  return { ...durable(0), seq: null, type: "ai_text_delta" };
}

function response(status: number): Response {
  return new Response(null, { status });
}

describe("durable delivery + retry", () => {
  it("acks and clears the buffer on 2xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200));
    const t = new Transport({
      railsInternalUrl: "http://rails:3000",
      sharedSecret: "s",
      logger: noopLogger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await t.deliverDurable([durable(1)])).toBe("acked");
    expect(t.bufferLength).toBe(0);
  });

  it("posts the frozen { events: [...] } shape with the bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200));
    const t = new Transport({
      railsInternalUrl: "http://rails:3000",
      sharedSecret: "shh",
      logger: noopLogger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await t.deliverDurable([durable(1)]);
    const init = fetchImpl.mock.calls[0]?.[1];
    if (!init) throw new Error("expected a fetch call");
    expect(JSON.parse(init.body)).toHaveProperty("events");
    expect(Array.isArray(JSON.parse(init.body).events)).toBe(true);
    expect(init.headers.authorization).toBe("Bearer shh");
  });

  it("buffers on 5xx and drains on recovery, re-sending the SAME (ai_run_id, seq)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200));
    const t = new Transport({
      railsInternalUrl: "http://rails:3000",
      sharedSecret: "s",
      logger: noopLogger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await t.deliverDurable([durable(7)])).toBe("buffered");
    expect(t.bufferLength).toBe(1);

    expect(await t.flush()).toBe("acked");
    expect(t.bufferLength).toBe(0);
    // Same seq on the retry — never renumbered.
    const retryInit = fetchImpl.mock.calls[1]?.[1];
    if (!retryInit) throw new Error("expected a retry fetch call");
    const retryBody = JSON.parse(retryInit.body);
    expect(retryBody.events[0].seq).toBe(7);
    expect(retryBody.events[0].ai_run_id).toBe("run_1");
  });

  it("buffers on a network error (does not discard)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const t = new Transport({
      railsInternalUrl: "http://rails:3000",
      sharedSecret: "s",
      logger: noopLogger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await t.deliverDurable([durable(1)])).toBe("buffered");
    expect(t.bufferLength).toBe(1);
  });
});

describe("4xx is fatal, not retried forever", () => {
  for (const status of [401, 403, 404, 422]) {
    it(`treats ${status} as fatal and stops`, async () => {
      const fetchImpl = vi.fn().mockResolvedValue(response(status));
      const t = new Transport({
        railsInternalUrl: "http://rails:3000",
        sharedSecret: "s",
        logger: noopLogger,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(await t.deliverDurable([durable(1)])).toBe("fatal");
      expect(t.isFatal).toBe(true);
      // A subsequent flush does not POST again.
      const callsAfter = fetchImpl.mock.calls.length;
      await t.flush();
      expect(fetchImpl.mock.calls.length).toBe(callsAfter);
    });
  }
});

describe("ephemeral fire-and-forget", () => {
  it("delivers ephemeral events but never buffers/retries them", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("down"));
    const t = new Transport({
      railsInternalUrl: "http://rails:3000",
      sharedSecret: "s",
      logger: noopLogger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await t.deliverEphemeral(ephemeral());
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(t.bufferLength).toBe(0); // never buffered even though the POST failed
  });
});

describe("ring buffer overflow", () => {
  it("evicts the oldest unsent event and logs data loss", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const fetchImpl = vi.fn().mockRejectedValue(new Error("down"));
    const t = new Transport({
      railsInternalUrl: "http://rails:3000",
      sharedSecret: "s",
      logger,
      maxBufferSize: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await t.deliverDurable([durable(1)]);
    await t.deliverDurable([durable(2)]);
    await t.deliverDurable([durable(3)]); // overflow -> evict seq 1
    expect(t.bufferLength).toBe(2);
    expect(logger.error).toHaveBeenCalled();
  });
});
