import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as checkpoint from "../../src/loop/checkpoint.js";
import { openStore } from "../../src/store/store.js";
import type { HarnessStoreApi, Write } from "../../src/store/types.js";

/**
 * Finding A1 — the per-step durable write cost, as a NUMBER.
 *
 * Every other budget in the requirements record is numeric and this one was prose, which is how a
 * "durable write on every step" design gets adopted without anyone knowing what it costs.
 * **p99 < 5ms per position-marker write.**
 *
 * 5ms is generous ON PURPOSE, and the generosity is the argument: a step already includes a model
 * round trip of hundreds of milliseconds, so the point is not to be fast — it is to prove the
 * durable write is provably not the limiting factor. A budget tight enough to flake on a busy CI
 * runner would get raised until it meant nothing.
 *
 * Measures the REAL store on a real temp filesystem — SQLite in WAL mode, `synchronous` as the
 * store configures it. A mocked store would measure nothing.
 */

const SAMPLES = 300;
const P99_BUDGET_MS = 5;

let dir: string;
let store: HarnessStoreApi;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "harness-write-cost-"));
  const opened = await openStore("45", { dir, owner: "write-cost" });
  if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
  store = opened.store;
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Sorted-sample percentile. `p` is a fraction, so p99 is 0.99. */
function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  // `Math.min` guards the top edge: at p=1 the computed index would be off the end.
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)] as number;
}

function report(label: string, samples: number[]): void {
  const p50 = percentile(samples, 0.5).toFixed(3);
  const p99 = percentile(samples, 0.99).toFixed(3);
  const max = Math.max(...samples).toFixed(3);
  // Printed, not just asserted: the number is the deliverable, and a future regression is far
  // easier to read against a recorded baseline than against a bare pass/fail.
  console.log(`${label}: n=${samples.length} p50=${p50}ms p99=${p99}ms max=${max}ms`);
}

/** One durable log entry, in the shape the loop writes. `seq` is unique per call. */
function entryWrite(seq: number, text: string): Write {
  return {
    kind: "entry",
    entry: {
      run_id: "run_1",
      seq,
      type: "ai_text",
      actor_kind: "claude",
      actor_id: null,
      ts_ms: 1,
      payload: { text },
      blocks: null,
      on_surface: 0,
      emitted: 1,
    },
  };
}

describe("a position-marker write", () => {
  it(`costs less than ${P99_BUDGET_MS}ms at p99`, () => {
    const samples: number[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const started = performance.now();
      store.commit({
        writes: [checkpoint.positionWrite("run_1", { phase: "checkpoint" })],
      });
      samples.push(performance.now() - started);
    }

    report("position marker", samples);
    expect(percentile(samples, 0.99)).toBeLessThan(P99_BUDGET_MS);
  });

  it("does not degrade as the log grows", () => {
    // The marker is a REGISTER write, resolved by key, so its cost must not depend on how much
    // history sits beside it. If it did, a long session would slow down step by step — the exact
    // property `recovery_o1.test.ts` proves for the READ side.
    const early: number[] = [];
    const late: number[] = [];

    for (let i = 0; i < 100; i += 1) {
      const started = performance.now();
      store.commit({ writes: [checkpoint.positionWrite("run_1", { phase: "checkpoint" })] });
      early.push(performance.now() - started);
    }

    // Grow the log by two orders of magnitude relative to the marker count.
    for (let i = 0; i < 2_000; i += 1) {
      store.commit({
        writes: [entryWrite(i, "x".repeat(200))],
      });
    }

    for (let i = 0; i < 100; i += 1) {
      const started = performance.now();
      store.commit({ writes: [checkpoint.positionWrite("run_1", { phase: "checkpoint" })] });
      late.push(performance.now() - started);
    }

    report("marker before 2k entries", early);
    report("marker after 2k entries", late);

    // A generous ratio, deliberately: this is asserting the absence of a scaling term, not a
    // stable constant. Machine noise on a shared runner moves the p99 around by more than the
    // effect being excluded would.
    expect(percentile(late, 0.99)).toBeLessThan(P99_BUDGET_MS);
    expect(percentile(late, 0.5)).toBeLessThan(percentile(early, 0.5) * 5 + 1);
  });

  it("is not the limiting factor next to a model round trip", () => {
    const samples: number[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const started = performance.now();
      store.commit({ writes: [checkpoint.positionWrite("run_1", { phase: "checkpoint" })] });
      samples.push(performance.now() - started);
    }

    // The claim the budget exists to support, stated as an assertion: a conservative 200ms for the
    // fastest realistic turn, and the durable write must be a small fraction of it.
    const FASTEST_PLAUSIBLE_TURN_MS = 200;
    expect(percentile(samples, 0.99)).toBeLessThan(FASTEST_PLAUSIBLE_TURN_MS / 10);
  });
});

describe("a full step's writes", () => {
  it("stay inside the budget when the marker rides with an entry", () => {
    // What the loop ACTUALLY commits per step: the assistant entry and the marker in one
    // transaction. Measuring the marker alone would understate the real per-step cost.
    const samples: number[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const started = performance.now();
      store.commit({
        writes: [
          entryWrite(i, "a plausible paragraph of assistant output."),
          checkpoint.positionWrite("run_1", { phase: "checkpoint" }),
        ],
      });
      samples.push(performance.now() - started);
    }

    report("entry + marker (one transaction)", samples);
    expect(percentile(samples, 0.99)).toBeLessThan(P99_BUDGET_MS);
  });
});
