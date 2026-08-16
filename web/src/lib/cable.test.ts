import type { EventEnvelope } from "@clawdparty/contracts";
import { describe, expect, it, vi } from "vitest";
import { CableController, type CatchUpHandle, type SessionChannel, startCatchUp } from "./cable";

function durable(id: number, type: EventEnvelope["type"] = "ai_text"): EventEnvelope {
  return {
    id,
    session_id: "s",
    ai_run_id: "run_1",
    seq: id,
    type,
    actor: { kind: "claude" },
    ts: "2026-06-28T20:11:00.000Z",
    payload: {},
  };
}

function deltaEvent(text: string): EventEnvelope {
  return {
    id: null,
    session_id: "s",
    ai_run_id: "run_1",
    seq: null,
    type: "ai_text_delta",
    actor: { kind: "claude" },
    ts: "2026-06-28T20:11:00.000Z",
    payload: { block: "blk", text },
  };
}

// A controllable fake channel: tests push live events via `emit`.
function fakeChannel(): { channel: SessionChannel; emit: (e: EventEnvelope) => void } {
  let handler: ((e: EventEnvelope) => void) | null = null;
  return {
    channel: {
      subscribe(onEvent) {
        handler = onEvent;
        return () => {
          handler = null;
        };
      },
    },
    emit: (e) => handler?.(e),
  };
}

describe("gap-free catch-up", () => {
  it("subscribes first, backfills, drains with no gap and no duplicate at the boundary", async () => {
    const applied: EventEnvelope[] = [];
    const { channel, emit } = fakeChannel();

    // Backfill returns 1..3. A live event id=3 (overlap) + id=4 (new) arrive
    // DURING catch-up and are buffered (subscribe-first), then drained.
    const backfill = async (after: number) =>
      [durable(1), durable(2), durable(3)].filter((e) => (e.id as number) > after);

    const handlePromise = startCatchUp({
      channel,
      backfill,
      apply: (e) => applied.push(e),
      maxAppliedId: () => 0,
    });
    // emit happens synchronously after subscribe (during the awaited backfill)
    emit(durable(3)); // overlaps backfill — must be dropped at the boundary
    emit(durable(4)); // new — must be applied
    await handlePromise;

    const ids = applied.map((e) => e.id);
    expect(ids).toEqual([1, 2, 3, 4]); // no gap (4 present), no duplicate (3 once)
  });

  it("applies an ephemeral (null-id) event buffered during catch-up, never dropping it", async () => {
    const applied: EventEnvelope[] = [];
    const { channel, emit } = fakeChannel();
    const backfill = async () => [durable(1), durable(2)];

    const p = startCatchUp({
      channel,
      backfill,
      apply: (e) => applied.push(e),
      maxAppliedId: () => 0,
    });
    emit(deltaEvent("hi")); // null id — must NOT be dropped by the id > max filter
    await p;

    expect(applied.some((e) => e.id === null && e.type === "ai_text_delta")).toBe(true);
  });

  it("reconnect re-runs backfill+drain idempotently from the max applied id", async () => {
    const applied: EventEnvelope[] = [];
    const { channel } = fakeChannel();
    let maxId = 0;
    let backfillCalls = 0;
    // The "server" grows over time: 1..2 initially, then 3 appears before reconnect.
    let available = [durable(1), durable(2)];
    const backfill = async (after: number) => {
      backfillCalls += 1;
      return available.filter((e) => (e.id as number) > after);
    };

    const controller = new CableController({
      channel,
      backfill,
      apply: (e) => {
        applied.push(e);
        if (e.id !== null) maxId = Math.max(maxId, e.id);
      },
      maxAppliedId: () => maxId,
    });
    controller.start();
    await new Promise((r) => setTimeout(r, 0)); // let initial catchUp resolve
    expect(applied.map((e) => e.id)).toEqual([1, 2]);
    expect(maxId).toBe(2);

    // A new event arrives; reconnect re-runs backfill from cursor=2.
    available = [durable(1), durable(2), durable(3)];
    await controller.catchUp();

    expect(backfillCalls).toBe(2);
    // Only id=3 is newly applied (backfill filtered after>2); 1,2 not re-applied.
    expect(applied.map((e) => e.id)).toEqual([1, 2, 3]);
  });
});

/**
 * the product's premise, asserted rather than assumed.
 *
 * clawdparty turns one Claude session into a shared room. If five people watching
 * the same run can end up with different state, there is no room — there are five
 * private guesses. Every other test here checks ONE subscriber's catch-up; this is
 * the only one that checks they AGREE.
 *
 * The sixth subscriber matters most. Joining mid-run is the case where divergence
 * would actually happen: they backfill a prefix while live events are already
 * arriving, and the boundary between the two is exactly where a gap or a duplicate
 * appears.
 */
describe("the shared room converges", () => {
  interface Subscriber {
    applied: EventEnvelope[];
    emit: (event: EventEnvelope) => void;
    handle: CatchUpHandle;
  }

  /** A full run's durable stream, plus two ephemeral deltas that must not be deduped. */
  function runStream(): EventEnvelope[] {
    return [
      durable(1, "run_started"),
      durable(2, "ai_thinking"),
      deltaEvent("stream"),
      durable(3, "ai_text"),
      durable(4, "tool_started"),
      deltaEvent("more"),
      durable(5, "tool_finished"),
      durable(6, "run_finished"),
    ];
  }

  /**
   * Join a subscriber whose backfill returns everything already broadcast. `joinAt`
   * is how many events have gone out before they arrive, which is what makes the
   * sixth subscriber a mid-run join rather than a replay.
   */
  async function join(stream: EventEnvelope[], joinAt: number): Promise<Subscriber> {
    const applied: EventEnvelope[] = [];
    let onEvent: ((e: EventEnvelope) => void) | null = null;

    const handle = await startCatchUp({
      channel: {
        subscribe: (handler) => {
          onEvent = handler;
          return () => {
            onEvent = null;
          };
        },
      },
      // Backfill returns the DURABLE prefix already broadcast — ephemeral events are
      // never persisted, so a late joiner legitimately never sees the ones it missed.
      backfill: async (afterId) =>
        stream.slice(0, joinAt).filter((e) => e.id !== null && e.id > afterId),
      apply: (event) => applied.push(event),
      maxAppliedId: () => applied.reduce((max, e) => (e.id !== null && e.id > max ? e.id : max), 0),
    });

    return { applied, emit: (event) => onEvent?.(event), handle };
  }

  it("five subscribers joining at the start converge on identical state", async () => {
    const stream = runStream();
    const subs = await Promise.all([0, 0, 0, 0, 0].map((at) => join(stream, at)));

    for (const event of stream) {
      for (const sub of subs) sub.emit(event);
    }

    const durableIds = subs.map((s) => s.applied.filter((e) => e.id !== null).map((e) => e.id));
    for (const ids of durableIds) {
      expect(ids).toEqual([1, 2, 3, 4, 5, 6]);
    }
    // Not merely "each is correct" — each is IDENTICAL to the first. Five correct
    // states that differ would still mean five different rooms.
    for (const ids of durableIds) {
      expect(ids).toEqual(durableIds[0]);
    }

    for (const sub of subs) sub.handle.stop();
  });

  it("a sixth joining MID-RUN reconstructs to the same durable state", async () => {
    const stream = runStream();
    const early = await Promise.all([0, 0, 0, 0, 0].map((at) => join(stream, at)));

    // Broadcast the first half to the five who are already watching.
    const half = 4;
    for (const event of stream.slice(0, half)) {
      for (const sub of early) sub.emit(event);
    }

    // The sixth arrives now: it backfills the prefix while the rest of the run is
    // still to come.
    const late = await join(stream, half);
    for (const event of stream.slice(half)) {
      for (const sub of [...early, late]) sub.emit(event);
    }

    const durableOf = (s: Subscriber) => s.applied.filter((e) => e.id !== null).map((e) => e.id);

    expect(durableOf(late)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const sub of early) {
      expect(durableOf(sub)).toEqual(durableOf(late));
    }

    for (const sub of [...early, late]) sub.handle.stop();
  });

  it("gives the late joiner no duplicate at the backfill/live boundary", async () => {
    // The boundary only EXISTS while backfill is in flight, so this test holds
    // backfill open and broadcasts into the buffering window. An earlier version
    // awaited catch-up first and then emitted, which meant nothing was ever buffered
    // and the assertion could not fail — it named the property without creating it.
    const stream = runStream();
    const half = 4;
    const applied: EventEnvelope[] = [];
    // Typed via a holder object: TS narrows a `let` assigned only inside a closure
    // to `never` at the call site, which is what made the direct form uncallable.
    const wire: { onEvent: ((e: EventEnvelope) => void) | null; release: (() => void) | null } = {
      onEvent: null,
      release: null,
    };

    const catchUp = startCatchUp({
      channel: {
        subscribe: (handler) => {
          wire.onEvent = handler;
          return () => {
            wire.onEvent = null;
          };
        },
      },
      backfill: async (afterId) => {
        await new Promise<void>((resolve) => {
          wire.release = resolve;
        });
        return stream.slice(0, half).filter((e) => e.id !== null && e.id > afterId);
      },
      apply: (event) => applied.push(event),
      maxAppliedId: () => applied.reduce((max, e) => (e.id !== null && e.id > max ? e.id : max), 0),
    });

    await vi.waitFor(() => expect(wire.release).not.toBeNull());
    // Broadcast events 3 and 4 WHILE backfill is pending — backfill will also return
    // them, so a naive drain applies each twice.
    wire.onEvent?.(stream[2] as EventEnvelope);
    wire.onEvent?.(stream[3] as EventEnvelope);
    wire.release?.();

    const handle = await catchUp;
    for (const event of stream.slice(half)) wire.onEvent?.(event);

    const ids = applied.filter((e) => e.id !== null).map((e) => e.id);
    expect(new Set(ids).size, `duplicated at the boundary: ${ids.join(",")}`).toBe(ids.length);
    expect(ids).toEqual([1, 2, 3, 4, 5, 6]);

    handle.stop();
  });

  it("does not replay missed EPHEMERAL events to a late joiner", async () => {
    const stream = runStream();
    const late = await join(stream, 4);

    for (const event of stream.slice(4)) late.emit(event);

    // Only the ONE delta broadcast after they joined. Ephemeral events are never
    // persisted, so backfilling them would be inventing history — and a delta
    // replayed after its durable ai_text settled would corrupt the accumulator.
    expect(late.applied.filter((e) => e.id === null)).toHaveLength(1);

    late.handle.stop();
  });
});
