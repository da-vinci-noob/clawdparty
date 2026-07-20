import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EventEnvelope } from "@clawdparty/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  selectDurableEvents,
  selectExecutablePlanRunId,
  selectLatestUsage,
  useEventStore,
} from "./event_store";

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

describe("selectExecutablePlanRunId", () => {
  beforeEach(() => useEventStore.getState().reset());

  function runStarted(id: number, runId: string, mode: string): EventEnvelope {
    return {
      id,
      session_id: "s",
      ai_run_id: runId,
      seq: 2,
      type: "run_started",
      actor: { kind: "user", id: "p1" },
      ts: "2026-07-17T00:00:00.000Z",
      payload: { model: "m", cwd: "/r", permission_mode: mode, claude_session_id: "x" },
    };
  }

  function runFinished(id: number, runId: string): EventEnvelope {
    return {
      id,
      session_id: "s",
      ai_run_id: runId,
      seq: 9,
      type: "run_finished",
      actor: { kind: "claude" },
      ts: "2026-07-17T00:01:00.000Z",
      payload: {},
    };
  }

  it("returns the run id when the last run was a finished plan run", () => {
    useEventStore.getState().applyMany([runStarted(1, "run1", "plan"), runFinished(2, "run1")]);
    expect(selectExecutablePlanRunId(useEventStore.getState())).toBe("run1");
  });

  it("returns null while the plan run is still active (not finished)", () => {
    useEventStore.getState().apply(runStarted(1, "run1", "plan"));
    expect(selectExecutablePlanRunId(useEventStore.getState())).toBeNull();
  });

  it("returns null when the last finished run was not plan mode", () => {
    useEventStore
      .getState()
      .applyMany([runStarted(1, "run1", "acceptEdits"), runFinished(2, "run1")]);
    expect(selectExecutablePlanRunId(useEventStore.getState())).toBeNull();
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
      payload: { model, cwd: "/r", permission_mode: "acceptEdits", claude_session_id: "x" },
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
