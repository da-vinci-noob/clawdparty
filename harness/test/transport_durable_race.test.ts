import type { EventEnvelope } from "@clawdparty/contracts";
import { describe, expect, it } from "vitest";
import { Transport } from "../src/transport.js";

/**
 * A durable event is never dropped without a log line saying so.
 *
 * `deliverDurable` is called UNAWAITED from `supervisor.ship()`, so two calls overlap
 * whenever the loop emits twice in quick succession — which it does every turn. Both then
 * run `flush()` against the SHARED buffer, and the ack does `splice(0, batch.length)`, which
 * assumes the buffer's head is still the batch it sent. Under concurrency it is not:
 *
 *   A takes [e1,e2] and posts (slow).
 *   B takes [e1,e2,e3] and posts; B acks -> splice(0,3) empties the buffer.
 *   e4 arrives; C posts it and FAILS, so e4 is kept for retry.
 *   A acks -> splice(0,2) -> deletes e4 from the retry buffer.
 *
 * e4 is now neither delivered nor buffered. Ring-buffer overflow at least logs "data loss";
 * this path is silent, and what is lost is a DURABLE event — a permanent hole in the Rails
 * projection of the record.
 *
 * The overlap is observable in production, not theoretical: a run's Rails log shows
 * `user_prompt,run_started,request_header` followed immediately by `user_prompt,run_started`,
 * and `ai_text` followed by `ai_text,run_finished`. Ingest is idempotent on
 * `(ai_run_id, seq)`, so those duplicates are harmless — the deletion is not.
 */

function durable(seq: number): EventEnvelope {
  return {
    id: null,
    session_id: "45",
    ai_run_id: "1",
    seq,
    type: "ai_text",
    actor: { kind: "claude" },
    ts: "2026-08-16T00:00:00.000Z",
    payload: { block: "b:0", text: `e${seq}` },
  } as EventEnvelope;
}

interface Rig {
  transport: Transport;
  delivered: () => number[];
  maxConcurrent: () => number;
  warnings: () => unknown[];
}

/**
 * `plan` maps a request's 1-based index to the status it should return; `hold` names the index
 * whose response waits for `release()`; `failFirstContaining` fails — once — whichever request
 * first carries that seq.
 *
 * The last one is keyed on CONTENT rather than request number on purpose: serialising the
 * flushes changes how many requests there are, so an index-keyed plan would target a different
 * batch before and after the fix and the test would not be comparing the same scenario.
 */
function rig(
  plan: Record<number, number> = {},
  hold?: number,
  failFirstContaining?: number,
): Rig & { release: () => void } {
  let failed = false;
  const delivered: number[] = [];
  const warnings: unknown[] = [];
  let requests = 0;
  let inFlight = 0;
  let maxConcurrent = 0;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const transport = new Transport({
    railsInternalUrl: "http://rails.test",
    sharedSecret: "s",
    logger: {
      info: () => {},
      warn: (obj) => warnings.push(obj),
      error: (obj) => warnings.push(obj),
    },
    fetchImpl: async (_url, init) => {
      const n = ++requests;
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      try {
        if (n === hold) await held;
        const body = JSON.parse((init as { body: string }).body) as { events: EventEnvelope[] };
        let status = plan[n] ?? 200;
        if (
          failFirstContaining !== undefined &&
          !failed &&
          body.events.some((e) => e.seq === failFirstContaining)
        ) {
          failed = true;
          status = 503;
        }
        if (status >= 200 && status < 300) {
          for (const event of body.events) delivered.push(event.seq as number);
        }
        return new Response("{}", { status });
      } finally {
        inFlight -= 1;
      }
    },
  });

  return {
    transport,
    release,
    delivered: () => delivered,
    maxConcurrent: () => maxConcurrent,
    warnings: () => warnings,
  };
}

describe("concurrent durable flushes", () => {
  it("does not delete an unacked event when an older flush acks", async () => {
    // The first request is held open so a later one overtakes it, and e4's first POST fails
    // so the retry buffer is the only thing that can still deliver it.
    const r = rig({}, 1, 4);

    const calls = [
      r.transport.deliverDurable([durable(1), durable(2)]),
      r.transport.deliverDurable([durable(3)]),
      r.transport.deliverDurable([durable(4)]),
    ];
    r.release();
    await Promise.all(calls);

    // e4's own POST failed, so the ONLY thing that can still deliver it is the retry
    // buffer. If an older ack spliced it out, this flush has nothing to send and e4 is
    // gone with no error anywhere.
    await r.transport.flush();
    expect(r.delivered()).toContain(4);
  });

  it("sends one request at a time, so acks cannot disagree about the buffer head", async () => {
    const r = rig({}, 1);

    const a = r.transport.deliverDurable([durable(1)]);
    const b = r.transport.deliverDurable([durable(2)]);
    r.release();
    await Promise.all([a, b]);

    // Serialising is what makes `splice(0, batch.length)` true rather than approximately
    // true. It also halves the traffic: every batch was previously re-sent by the next
    // overlapping flush, which the production log shows on every run.
    expect(r.maxConcurrent()).toBe(1);
  });

  it("still delivers everything, in order, across many overlapping calls", async () => {
    const r = rig({}, 1);

    const calls = Array.from({ length: 8 }, (_unused, i) =>
      r.transport.deliverDurable([durable(i + 1)]),
    );
    r.release();
    await Promise.all(calls);
    await r.transport.flush();

    expect([...new Set(r.delivered())]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r.transport.bufferLength).toBe(0);
  });

  it("keeps a transient failure buffered and reports it", async () => {
    const r = rig({ 1: 503 });

    const outcome = await r.transport.deliverDurable([durable(1)]);

    expect(outcome).toBe("buffered");
    expect(r.transport.bufferLength).toBe(1);
    expect(r.warnings()).toHaveLength(1);
  });

  it("stops on a fatal 4xx rather than retrying forever", async () => {
    const r = rig({ 1: 422 });

    expect(await r.transport.deliverDurable([durable(1)])).toBe("fatal");
    expect(r.transport.isFatal).toBe(true);
  });
});
