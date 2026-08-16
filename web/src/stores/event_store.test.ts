import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EventEnvelope } from "@clawdparty/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { selectDurableEvents, selectLatestUsage, useEventStore } from "./event_store";

// The executable contract fixture (real spike-derived envelopes, v1.1). Resolved
// from the web/ package root (vitest runs with cwd = web/).
const fixturePath = resolve(process.cwd(), "../packages/contracts/fixtures/sample_run.jsonl");
const fixture: EventEnvelope[] = readFileSync(fixturePath, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

function delta(aiRunId: string, block: string, text: string): EventEnvelope {
  return {
    id: null,
    session_id: "s",
    ai_run_id: aiRunId,
    seq: null,
    type: "ai_text_delta",
    actor: { kind: "claude" },
    ts: "2026-06-28T20:11:00.000Z",
    payload: { block, text },
  };
}

function presence(participantId: string, online: boolean): EventEnvelope {
  return {
    id: null,
    session_id: "s",
    ai_run_id: null,
    seq: null,
    type: "presence_changed",
    actor: { kind: "user", id: participantId },
    ts: "2026-06-28T20:11:00.000Z",
    payload: { participant_id: participantId, online },
  };
}

describe("event_store", () => {
  beforeEach(() => useEventStore.getState().reset());

  it("dedupes durable events by id (idempotent across backfill + live)", () => {
    const store = useEventStore.getState();
    const durable = fixture.filter((e) => e.id !== null);
    store.applyMany(durable);
    store.applyMany(durable); // re-apply the same set (simulating backfill + live overlap)

    const got = selectDurableEvents(useEventStore.getState());
    expect(got.length).toBe(durable.length);
    // ascending id order preserved
    const ids = got.map((e) => e.id as number);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it("accumulates ai_text_delta by (ai_run_id, block) and never dedupes them", () => {
    const store = useEventStore.getState();
    store.apply(delta("run_1", "blkA", "Hel"));
    store.apply(delta("run_1", "blkA", "lo"));
    store.apply(delta("run_1", "blkB", "World"));

    const state = useEventStore.getState();
    expect(state.textByBlock.get("run_1::blkA")).toBe("Hello");
    expect(state.textByBlock.get("run_1::blkB")).toBe("World");
    // ephemeral deltas are NOT in the durable log
    expect(selectDurableEvents(state).length).toBe(0);
  });

  it("accumulates ai_thinking_delta into thinkingByBlock (separate from text)", () => {
    const store = useEventStore.getState();
    store.apply({ ...delta("run_1", "m:0", "th"), type: "ai_thinking_delta" });
    store.apply({ ...delta("run_1", "m:0", " inking"), type: "ai_thinking_delta" });
    const state = useEventStore.getState();
    expect(state.thinkingByBlock.get("run_1::m:0")).toBe("th inking");
    expect(state.textByBlock.size).toBe(0);
    expect(selectDurableEvents(state).length).toBe(0);
  });

  it("clears the live accumulator when the durable ai_text/ai_thinking settles (no duplicate)", () => {
    const store = useEventStore.getState();
    store.apply(delta("run_1", "m:1", "Hello"));
    store.apply({ ...delta("run_1", "m:0", "why"), type: "ai_thinking_delta" });
    expect(useEventStore.getState().textByBlock.get("run_1::m:1")).toBe("Hello");

    const durable = (type: string, block: string, id: number): EventEnvelope => ({
      id,
      session_id: "s",
      ai_run_id: "run_1",
      seq: id,
      type: type as EventEnvelope["type"],
      actor: { kind: "claude" },
      ts: "2026-06-28T20:11:01.000Z",
      payload: { block, text: "settled" },
    });
    store.apply(durable("ai_text", "m:1", 1));
    store.apply(durable("ai_thinking", "m:0", 2));

    const state = useEventStore.getState();
    expect(state.textByBlock.has("run_1::m:1")).toBe(false); // live block dropped
    expect(state.thinkingByBlock.has("run_1::m:0")).toBe(false);
    expect(selectDurableEvents(state).length).toBe(2); // rendered once, from the durable log
  });

  // Deltas and durable events travel over two INDEPENDENT channels: deltas are coalesced
  // into a ~150ms window in the harness while durable batches POST immediately, so an
  // `ai_text` routinely lands before the tail of its own delta stream. Without this guard
  // the late delta re-creates the accumulator for a block that already settled, and
  // `activity_feed.tsx` renders every accumulator — the paragraph appears TWICE, once
  // settled and once as a partial fragment below it. No transport ordering can fix this;
  // the two channels are independent by design, so the client has to be the one that knows.
  describe("a delta that arrives after its block settled", () => {
    const settled = (type: string, block: string, id: number): EventEnvelope => ({
      id,
      session_id: "s",
      ai_run_id: "run_1",
      seq: id,
      type: type as EventEnvelope["type"],
      actor: { kind: "claude" },
      ts: "2026-06-28T20:11:01.000Z",
      payload: { block, text: "the whole settled paragraph" },
    });

    it("is dropped rather than re-creating the live block", () => {
      const store = useEventStore.getState();
      store.apply(delta("run_1", "m:1", "the whole settled "));
      store.apply(settled("ai_text", "m:1", 1));
      store.apply(delta("run_1", "m:1", "paragraph"));

      const state = useEventStore.getState();
      expect(state.textByBlock.has("run_1::m:1")).toBe(false);
      expect(selectDurableEvents(state).length).toBe(1);
    });

    it("is dropped for thinking blocks too", () => {
      const store = useEventStore.getState();
      store.apply(settled("ai_thinking", "m:0", 1));
      store.apply({ ...delta("run_1", "m:0", "late reasoning"), type: "ai_thinking_delta" });

      expect(useEventStore.getState().thinkingByBlock.has("run_1::m:0")).toBe(false);
    });

    it("does not block a DIFFERENT block on the same run", () => {
      const store = useEventStore.getState();
      store.apply(settled("ai_text", "m:1", 1));
      store.apply(delta("run_1", "m:2", "the next paragraph, still streaming"));

      // Settling one block must not stop the block that starts right after it — a turn
      // emits several, and the next one is live the moment the previous settles.
      expect(useEventStore.getState().textByBlock.get("run_1::m:2")).toBe(
        "the next paragraph, still streaming",
      );
    });

    it("does not leak settled keys across runs", () => {
      const store = useEventStore.getState();
      store.apply(settled("ai_text", "m:1", 1));
      store.apply({ ...delta("run_2", "m:1", "different run, same block name") });

      // Block keys are per-message-uuid in production, but nothing in the envelope
      // guarantees a fresh run cannot reuse one.
      expect(useEventStore.getState().textByBlock.get("run_2::m:1")).toBe(
        "different run, same block name",
      );
    });
  });

  it("sweeps a run's live blocks on a terminal run event (safety net)", () => {
    const store = useEventStore.getState();
    store.apply(delta("run_1", "m:1", "partial"));
    store.apply({ ...delta("run_1", "m:0", "hmm"), type: "ai_thinking_delta" });
    store.apply({
      id: 9,
      session_id: "s",
      ai_run_id: "run_1",
      seq: 9,
      type: "run_finished",
      actor: { kind: "system" },
      ts: "2026-06-28T20:11:02.000Z",
      payload: {},
    });
    const state = useEventStore.getState();
    expect(state.textByBlock.size).toBe(0);
    expect(state.thinkingByBlock.size).toBe(0);
  });

  it("applies presence_changed last-writer-wins per participant", () => {
    const store = useEventStore.getState();
    store.apply(presence("p1", true));
    store.apply(presence("p1", false));
    store.apply(presence("p2", true));

    const state = useEventStore.getState();
    expect(state.presenceByParticipant.get("p1")).toBe(false);
    expect(state.presenceByParticipant.get("p2")).toBe(true);
  });

  it("tracks maxAppliedId from durable events only", () => {
    const store = useEventStore.getState();
    store.applyMany(fixture); // includes ephemeral (null id) — must not affect maxAppliedId
    const durableIds = fixture.filter((e) => e.id !== null).map((e) => e.id as number);
    expect(useEventStore.getState().maxAppliedId).toBe(Math.max(...durableIds));
  });
});

describe("selectLatestUsage", () => {
  beforeEach(() => useEventStore.getState().reset());

  function started(id: number, runId: string, model: string): EventEnvelope {
    return {
      id,
      session_id: "s",
      ai_run_id: runId,
      seq: 2,
      type: "run_started",
      actor: { kind: "user", id: "p1" },
      ts: "2026-07-20T00:00:00.000Z",
      payload: { model, cwd: "/r" },
    };
  }

  function finished(
    id: number,
    runId: string,
    usage: Record<string, number>,
    type: "run_finished" | "run_failed" = "run_finished",
  ): EventEnvelope {
    return {
      id,
      session_id: "s",
      ai_run_id: runId,
      seq: 9,
      type,
      actor: { kind: "claude" },
      ts: "2026-07-20T00:01:00.000Z",
      payload: { usage },
    };
  }

  it("returns null before any run completes", () => {
    useEventStore.getState().apply(started(1, "run1", "claude-opus-4-8"));
    expect(selectLatestUsage(useEventStore.getState())).toBeNull();
  });

  it("sums prompt-side tokens (input + cache read + cache creation) and returns the model", () => {
    useEventStore.getState().applyMany([
      started(1, "run1", "claude-opus-4-8"),
      finished(2, "run1", {
        input_tokens: 100_000,
        output_tokens: 5000,
        cache_read_input_tokens: 20_000,
        cache_creation_input_tokens: 4000,
      }),
    ]);
    expect(selectLatestUsage(useEventStore.getState())).toEqual({
      contextTokens: 124_000,
      model: "claude-opus-4-8",
    });
  });

  it("uses the most recent completed run when several exist (incl. run_failed)", () => {
    useEventStore
      .getState()
      .applyMany([
        started(1, "run1", "claude-opus-4-8"),
        finished(2, "run1", { input_tokens: 10_000 }),
        started(3, "run2", "claude-sonnet-5"),
        finished(4, "run2", { input_tokens: 50_000 }, "run_failed"),
      ]);
    expect(selectLatestUsage(useEventStore.getState())).toEqual({
      contextTokens: 50_000,
      model: "claude-sonnet-5",
    });
  });
});
