import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore } from "../../src/store/store.js";
import type { HarnessStoreApi } from "../../src/store/types.js";

/**
 * recovery does not grow with session length, across sessions spanning
 * two orders of magnitude of history.
 *
 * A naive timing assertion here would be either flaky or vacuous. This test
 * measures a CONTROL query that is genuinely O(n) over the same data alongside
 * `readPosition()`, and requires the control to actually show growth before
 * trusting the flat result. If the machine is too noisy to observe the control
 * growing, the test FAILS rather than passing for the wrong reason — a
 * measurement harness that cannot detect the thing it rules out is not evidence.
 */

const SMALL = 200;
const LARGE = 20_000; // 100x — the two orders of magnitude  names
const READS = 2_000;

let dir: string;
const open: HarnessStoreApi[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-o1-"));
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
  rmSync(dir, { recursive: true, force: true });
});

async function seed(sessionId: string, entries: number): Promise<HarnessStoreApi> {
  const result = await openStore(sessionId, { dir, owner: `owner-${sessionId}` });
  if (!result.ok) throw new Error(`open failed: ${result.reason}`);
  const store = result.store;
  open.push(store);

  store.commit({
    writes: [
      {
        kind: "register",
        op: "set",
        namespace: "run.position",
        key: "run_1",
        value: {
          phase: "request_pending",
          reservedEntrySeq: entries + 1,
          reservedUsageId: 1,
          requestSnapshotId: "snap",
          attempt: 1,
          maxAttempts: 3,
          notBeforeMs: 0,
        },
      },
    ],
  });

  // One transaction: the point is the resulting row count, not insert cost.
  store.commit({
    writes: Array.from({ length: entries }, (_unused, i) => ({
      kind: "entry" as const,
      entry: {
        run_id: "run_1",
        seq: i + 1,
        type: "ai_text" as const,
        actor_kind: "claude" as const,
        actor_id: null,
        ts_ms: 1_700_000_000_000 + i,
        payload: { block: `b:${i}`, text: `chunk ${i}` },
        blocks: null,
        on_surface: 0 as const,
      },
    })),
  });

  return store;
}

function timeIt(iterations: number, fn: () => void): number {
  fn(); // warm the prepared statement and page cache
  const started = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  return performance.now() - started;
}

describe("readPosition is O(1) in session length", () => {
  it("stays flat across a 100x difference in log size, with a control that does not", async () => {
    const small = await seed("small", SMALL);
    const large = await seed("large", LARGE);

    expect(small.entriesFrom(0)).toHaveLength(SMALL);
    expect(large.entriesFrom(0)).toHaveLength(LARGE);

    const smallRead = timeIt(READS, () => small.readPosition("run_1"));
    const largeRead = timeIt(READS, () => large.readPosition("run_1"));

    // The control: a full scan of the same `entries` table. This is what
    // readPosition would look like if recovery consulted the log.
    const scan = (db: Database.Database) => {
      const stmt = db.prepare("SELECT COUNT(*) AS c FROM entries WHERE payload LIKE '%chunk%'");
      return () => void stmt.get();
    };
    const smallDb = new Database(join(dir, "session-small.sqlite3"), { readonly: true });
    const largeDb = new Database(join(dir, "session-large.sqlite3"), { readonly: true });
    const controlRatio = timeIt(50, scan(largeDb)) / Math.max(timeIt(50, scan(smallDb)), 0.0001);
    smallDb.close();
    largeDb.close();

    // Guard the guard: if the control does not grow, this machine cannot
    // distinguish O(1) from O(n) right now and a flat readPosition proves nothing.
    expect(
      controlRatio,
      `control scan did not grow with 100x data (ratio ${controlRatio.toFixed(1)}); measurement cannot distinguish O(1) from O(n)`,
    ).toBeGreaterThan(10);

    const readRatio = largeRead / Math.max(smallRead, 0.0001);
    expect(
      readRatio,
      `readPosition scaled with log size (ratio ${readRatio.toFixed(2)}, control ${controlRatio.toFixed(1)})`,
    ).toBeLessThan(3);
  });

  it("resolves a position far inside the 30s recovery budget", async () => {
    const large = await seed("large", LARGE);

    const started = performance.now();
    const position = large.readPosition("run_1");
    const elapsed = performance.now() - started;

    expect(position).toMatchObject({ phase: "request_pending" });
    expect(elapsed).toBeLessThan(100);
  });

  it("lists active runs without scanning entries", async () => {
    const large = await seed("large", LARGE);

    // activeRunIds() is the  reconciliation source and is called on every
    // heartbeat, so it must not walk the log either.
    const elapsed = timeIt(READS, () => large.activeRunIds());

    expect(large.activeRunIds()).toEqual(["run_1"]);
    expect(elapsed / READS).toBeLessThan(1);
  });
});
