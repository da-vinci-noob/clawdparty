import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore } from "../../src/store/store.js";
import type { HarnessStoreApi, Write } from "../../src/store/types.js";

/**
 * `store_seq` must identify the ENTRY, because that is what the projection check compares.
 *
 * Found by running scenario S4 step 3 against a live session. `Supervisor.ship` stamped every
 * durable event in a batch with `store.maxStoreSeq()` — one value for the whole batch, read AFTER the
 * commit — so Rails received:
 *
 *   RAILS  : [[2,"user_prompt",1], [2,"run_started",2], [3,"request_header",3], [6,"ai_thinking",4]]
 *   HARNESS: [[1,"user_prompt",1], [2,"run_started",2], [3,"request_header",3], [4,"ai_thinking",4]]
 *
 * Two events sharing a store_seq, and a drift that grows because the position marker is itself a row.
 * `ProjectionCheck` digests `(store_seq, type, seq)` triples from both sides, so it could never match
 * — and until `store_seq` was permitted through strong params at all, that was invisible: Rails looked
 * empty and every session reported diverged for the other reason.
 *
 * The lookup this pins is backed by `UNIQUE (run_id, seq)`, which is the same index that makes ingest
 * idempotent — so it is an existing guarantee, not a new one.
 */

let dir: string;
let store: HarnessStoreApi;

/** Matches the shape the other store specs use — `emitted` is NOT NULL in the schema. */
function entry(seq: number, type: string): Write {
  return {
    kind: "entry",
    entry: {
      run_id: "r1",
      seq,
      type: type as never,
      actor_kind: "claude",
      actor_id: null,
      ts_ms: 1_700_000_000_000,
      payload: {},
      blocks: null,
      on_surface: 0,
      emitted: 1,
    },
  } as unknown as Write;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "harness-storeseq-"));
  const opened = await openStore("55", { dir, owner: "storeseq" });
  if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
  store = opened.store;
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("an entry's own store_seq is findable", () => {
  it("returns a DIFFERENT position for each entry in one commit", () => {
    store.commit({ writes: [entry(1, "user_prompt"), entry(2, "run_started")] });

    const first = store.storeSeqFor("r1", 1);
    const second = store.storeSeqFor("r1", 2);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // The defect in one line: both were reported as the same number.
    expect(second).not.toBe(first);
  });

  it("matches what entriesFrom reports, which is what the check compares against", () => {
    store.commit({ writes: [entry(1, "user_prompt"), entry(2, "run_started")] });

    for (const e of store.entriesFrom(0)) {
      if (e.run_id && e.seq !== null) {
        expect(store.storeSeqFor(e.run_id, e.seq)).toBe(e.store_seq);
      }
    }
  });

  it("is not the store's high-water mark, which is what was being sent", () => {
    store.commit({ writes: [entry(1, "user_prompt")] });
    store.commit({ writes: [entry(2, "run_started")] });

    // The first entry's position must not move when later rows are added.
    expect(store.storeSeqFor("r1", 1)).toBeLessThan(store.maxStoreSeq());
  });

  it("returns null for an entry that does not exist, rather than guessing", () => {
    expect(store.storeSeqFor("r1", 99)).toBeNull();
  });
});
