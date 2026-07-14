import type { EventEnvelope } from "@clawdparty/contracts";
import { describe, expect, it } from "vitest";
import { CableController, type SessionChannel, startCatchUp } from "./cable";

function durable(id: number): EventEnvelope {
  return {
    id,
    session_id: "s",
    ai_run_id: "run_1",
    seq: id,
    type: "ai_text",
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
