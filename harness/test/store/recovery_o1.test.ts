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
 * THREE assertions, ordered from deterministic to empirical, because the enforcement should
 * not rest on a stopwatch:
 *
 *  1. The QUERY PLAN is identical at 200 and 20,000 entries, resolves `registers` by its
 *    primary key, and never mentions `entries`. This is what O(1) means here, it is exactly
 *    reproducible, and a loaded machine cannot make it flake.
 *  2. An ABSOLUTE budget on the large store. What  actually needs is a position resolved
 *    far inside the 30s recovery window; 100ms for an indexed read has ~1000x of headroom, so
 *    it fails only for a real regression.
 *  3. The empirical ratio, which is the only one that can observe an accidental scan the plan
 *    analysis missed. It measures a CONTROL query that is genuinely O(n) over the same data
 *    and requires the control to show growth before trusting the flat result — otherwise the
 *    measurement cannot detect what it claims to rule out. RETRIED, because that guard used
 *    to fail the whole gate on one load spike from an unrelated process, and a required gate
 *    that cries wolf is a gate people learn to re-run instead of read.
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
        emitted: 1 as const,
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

/** The plan for the one query recovery issues, as SQLite resolves it. */
function positionPlan(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT value FROM registers WHERE namespace = 'run.position' AND key = 'run_1'`,
    )
    .all() as Array<{ detail: string }>;
  db.close();
  return rows.map((r) => r.detail).join(" | ");
}

/** One measurement round: the read ratio and the O(n) control ratio over the same data. */
function measure(
  small: HarnessStoreApi,
  large: HarnessStoreApi,
): { read: number; control: number } {
  const smallRead = timeIt(READS, () => small.readPosition("run_1"));
  const largeRead = timeIt(READS, () => large.readPosition("run_1"));

  // The control: a full scan of the same `entries` table. This is what readPosition would
  // look like if recovery consulted the log.
  const scan = (db: Database.Database) => {
    const stmt = db.prepare("SELECT COUNT(*) AS c FROM entries WHERE payload LIKE '%chunk%'");
    return () => void stmt.get();
  };
  const smallDb = new Database(join(dir, "session-small.sqlite3"), { readonly: true });
  const largeDb = new Database(join(dir, "session-large.sqlite3"), { readonly: true });
  const control = timeIt(50, scan(largeDb)) / Math.max(timeIt(50, scan(smallDb)), 0.0001);
  smallDb.close();
  largeDb.close();

  return { read: largeRead / Math.max(smallRead, 0.0001), control };
}

describe("readPosition is O(1) in session length", () => {
  it("resolves by index and never touches `entries`, at ANY log size", async () => {
    const small = await seed("small", SMALL);
    const large = await seed("large", LARGE);
    expect(small.entriesFrom(0)).toHaveLength(SMALL);
    expect(large.entriesFrom(0)).toHaveLength(LARGE);

    const smallPlan = positionPlan(join(dir, "session-small.sqlite3"));
    const largePlan = positionPlan(join(dir, "session-large.sqlite3"));

    // The deterministic core of , and the one assertion in this file a busy machine
    // cannot disturb. IDENTICAL plans at 100x the data is the structural statement of
    // "does not grow with session length"; a plan that changed with size would mean the
    // query planner had started doing something else at scale.
    expect(smallPlan).toBe(largePlan);
    expect(largePlan).toMatch(/registers/);
    expect(largePlan).not.toMatch(/SCAN/);
    // `entries` appearing at all would mean recovery consults the LOG, which invariant 6
    // forbids outright — that is the design property, not a performance preference.
    expect(largePlan).not.toMatch(/entries/);
  });

  it("stays flat across a 100x difference in log size, with a control that does not", async () => {
    const small = await seed("small", SMALL);
    const large = await seed("large", LARGE);

    // RETRIED. The control-growth guard is right — a measurement that cannot observe the
    // thing it rules out is not evidence — but one load spike from an unrelated process
    // used to fail the whole gate. Three attempts make a transient spike survivable while
    // a machine that genuinely cannot measure still fails, loudly, with both numbers.
    const attempts: Array<{ read: number; control: number }> = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const round = measure(small, large);
      attempts.push(round);
      if (round.control > 10 && round.read < 3) return;
    }

    const best = attempts.reduce((a, b) => (b.control > a.control ? b : a));
    const report = attempts
      .map((a, i) => `#${i + 1} read ${a.read.toFixed(2)} control ${a.control.toFixed(1)}`)
      .join("; ");

    // Reported separately because the two failures mean opposite things: a low control is
    // "this machine cannot measure right now", a high read ratio is a real regression.
    expect(
      best.control,
      `control scan never grew with 100x data across 3 attempts (${report}); measurement cannot distinguish O(1) from O(n)`,
    ).toBeGreaterThan(10);
    expect(best.read, `readPosition scaled with log size (${report})`).toBeLessThan(3);
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
