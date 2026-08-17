import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimLane, laneScoped } from "../../src/store/lane_scope.js";
import { openStore } from "../../src/store/store.js";
import type { HarnessStoreApi, Write } from "../../src/store/types.js";

/**
 * two lanes progress concurrently, commits stay atomic, and one lane's fate does
 * not touch the other.
 *
 * The store is where this has to be proven. Two lanes SHARE one store (the supervisor refcounts it
 * per session, deliberately: opening one per run made the second lane collide on `session.lock`),
 * so every guarantee  makes reduces to whether interleaved commits through that one store keep
 * each lane's history and marker consistent.
 *
 * "Serialize lanes at the COMMIT boundary, not the run boundary" is the design under test.
 * A lane's entries and the `lane.leaf` marker saying where that lane now ends are written in ONE
 * transaction, so a concurrent lane can never observe entries no leaf covers, nor a leaf pointing
 * past entries that rolled back.
 */

const entry = (runId: string, seq: number, text: string): Write => ({
  kind: "entry",
  entry: {
    run_id: runId,
    seq,
    type: "ai_text",
    actor_kind: "claude",
    actor_id: null,
    ts_ms: 1,
    payload: { text },
    // Required by a CHECK constraint whenever `on_surface` is 1: a surface entry must carry the
    // provider's verbatim blocks, because the next request folds them back unedited (R6).
    blocks: [{ type: "text", text }],
    on_surface: 1,
    emitted: 1,
  },
});

let dir: string;
let store: HarnessStoreApi;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "harness-lanes-"));
  mkdirSync(dir, { recursive: true });
  const opened = await openStore("45", { dir, owner: "lanes" });
  if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
  store = opened.store;
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("two lanes over one store", () => {
  it("each advances its OWN leaf, and neither sees the other's", () => {
    const main = laneScoped(store, "main");
    const review = laneScoped(store, "review");

    main.commit({ writes: [entry("run_a", 1, "main first")] });
    review.commit({ writes: [entry("run_b", 1, "review first")] });
    main.commit({ writes: [entry("run_a", 2, "main second")] });

    const mainLeaf = store.readRegister("lane.leaf", "main");
    const reviewLeaf = store.readRegister("lane.leaf", "review");

    // main wrote store_seq 1 and 3; review wrote 2. If the leaf were session-global, both would
    // read 3 and review would resume from history it never produced.
    expect(mainLeaf?.storeSeq).toBe(3);
    expect(reviewLeaf?.storeSeq).toBe(2);
  });

  it("interleaves commits without either lane losing an entry", () => {
    const main = laneScoped(store, "main");
    const review = laneScoped(store, "review");

    for (let i = 1; i <= 20; i += 1) {
      // Strictly alternating, which is the shape two live lanes actually produce.
      (i % 2 === 0 ? main : review).commit({
        writes: [entry(i % 2 === 0 ? "run_a" : "run_b", Math.ceil(i / 2), `turn ${i}`)],
      });
    }

    const entries = store.entriesFrom(0);
    expect(entries).toHaveLength(20);
    expect(entries.filter((e) => e.run_id === "run_a")).toHaveLength(10);
    expect(entries.filter((e) => e.run_id === "run_b")).toHaveLength(10);
  });

  it("keeps store_seq globally ordered across lanes", () => {
    const main = laneScoped(store, "main");
    const review = laneScoped(store, "review");

    main.commit({ writes: [entry("run_a", 1, "a")] });
    review.commit({ writes: [entry("run_b", 1, "b")] });
    main.commit({ writes: [entry("run_a", 2, "c")] });

    // One monotonic sequence over the SESSION, with lanes interleaved inside it. That is what lets
    // Rails project a single ordered feed for the room while each lane keeps its own cursor.
    const seqs = store.entriesFrom(0).map((e) => e.store_seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

describe("a commit is atomic per lane", () => {
  it("advances the leaf only when the transaction actually wrote history", () => {
    const main = laneScoped(store, "main");
    main.commit({ writes: [entry("run_a", 1, "real")] });
    const afterEntry = store.readRegister("lane.leaf", "main")?.storeSeq;

    // A register-only commit changes no history, so claiming a new leaf for it would assert
    // history this lane does not have.
    main.commit({
      writes: [
        {
          kind: "register",
          op: "set",
          namespace: "run.position",
          key: "run_a",
          value: { phase: "checkpoint" },
        },
      ],
    });

    expect(store.readRegister("lane.leaf", "main")?.storeSeq).toBe(afterEntry);
  });

  it("does not advance a lane's leaf on a DUPLICATE entry", () => {
    const main = laneScoped(store, "main");
    main.commit({ writes: [entry("run_a", 1, "first")] });
    main.commit({ writes: [entry("run_a", 2, "second")] });
    const before = store.readRegister("lane.leaf", "main")?.storeSeq;

    // Re-committing `(run_a, 1)` is skipped by the idempotency index, so it produces no store_seq
    // — and a leaf that moved anyway would point at nothing new.
    main.commit({ writes: [entry("run_a", 1, "first again")] });

    expect(store.readRegister("lane.leaf", "main")?.storeSeq).toBe(before);
  });

  it("leaves a NON-lane-scoped commit out of every lane's leaf", () => {
    const main = laneScoped(store, "main");
    main.commit({ writes: [entry("run_a", 1, "lane work")] });
    const before = store.readRegister("lane.leaf", "main")?.storeSeq;

    // Recovery and session bookkeeping write through the RAW store. Attributing those to whichever
    // lane happened to be running is exactly what the optional `lane` avoids.
    store.commit({ writes: [entry("run_c", 1, "session-level")] });

    expect(store.readRegister("lane.leaf", "main")?.storeSeq).toBe(before);
  });

  it("respects an EXPLICIT lane on a transaction over the view's own", () => {
    const main = laneScoped(store, "main");
    main.commit({ writes: [entry("run_a", 1, "x")], lane: "review" });

    // The view supplies a default, not an override — otherwise a caller that knows better could
    // not say so.
    expect(store.readRegister("lane.leaf", "review")?.storeSeq).toBe(1);
    expect(store.readRegister("lane.leaf", "main")).toBeNull();
  });
});

describe("lane ownership lives in the record", () => {
  it("names the run that holds the lane", () => {
    const main = laneScoped(store, "main");
    claimLane(main, "main", "run_a");

    // In-memory ownership dies with the process; this is what a restart can still read.
    expect(store.readRegister("lane.state", "main")).toEqual({
      currentRunId: "run_a",
      pendingNext: null,
    });
  });

  it("releases the lane without disturbing the other", () => {
    claimLane(laneScoped(store, "main"), "main", "run_a");
    claimLane(laneScoped(store, "review"), "review", "run_b");

    claimLane(laneScoped(store, "main"), "main", null);

    // Interrupting or finishing one lane must leave the other's ownership intact.
    expect(store.readRegister("lane.state", "main")?.currentRunId).toBeNull();
    expect(store.readRegister("lane.state", "review")?.currentRunId).toBe("run_b");
  });

  it("does not advance a leaf just by claiming a lane", () => {
    claimLane(laneScoped(store, "main"), "main", "run_a");

    // Claiming writes a register only. A leaf appearing here would say the lane had history
    // before its first turn.
    expect(store.readRegister("lane.leaf", "main")).toBeNull();
  });
});

describe("the lane-scoped view", () => {
  it("keeps every store method, not just the ones spread over an object", () => {
    const main = laneScoped(store, "main");
    main.commit({ writes: [entry("run_a", 1, "x")] });

    // `{ ...store }` copies own properties only, so a prototype method would vanish and the loop
    // would fail on whichever one it reached first. Prototype delegation is why these work.
    expect(main.maxStoreSeq()).toBe(1);
    expect(main.highestSeq("run_a")).toBe(1);
    expect(main.entriesFrom(0)).toHaveLength(1);
    expect(main.surfaceFrom(0)).toHaveLength(1);
    expect(main.activeRunIds()).toEqual([]);
    expect(main.readPosition("run_a")).toBeNull();
  });

  it("shares the underlying store, so both views see one history", () => {
    laneScoped(store, "main").commit({ writes: [entry("run_a", 1, "from main")] });

    // The same store, viewed twice — not two stores. Opening one per lane is what collided on
    // `session.lock`.
    expect(laneScoped(store, "review").entriesFrom(0)).toHaveLength(1);
  });
});
