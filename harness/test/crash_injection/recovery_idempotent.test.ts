import { describe, expect, it } from "vitest";
import * as checkpoint from "../../src/loop/checkpoint.js";
import { applyRecovery } from "../../src/store/recovery.js";
import { RUN, commitBoundaries, inspect, readEffects, recover, runToCrash } from "./harness.js";

/**
 * A kill DURING recovery is itself recoverable.
 *
 * The case that is easy to miss: recovery writes, so recovery can crash, and a recovery
 * that is only safe to run once turns a single crash into a permanently stuck session.
 * This is what makes the reserved-id design load-bearing rather than tidy — settling
 * under a pre-reserved id means a second attempt is REJECTED BY THE SCHEMA
 * (UNIQUE (run_id, seq)) instead of appending a duplicate.
 */

const boundaries = commitBoundaries();

describe("recovery is idempotent", () => {
  it.each(boundaries)(
    "recovering twice from commit %i changes nothing the second time",
    async (at) => {
      const crashed = runToCrash(at);

      const first = await recover(crashed);
      const second = await recover(crashed);

      // The record must be identical. Anything else means a replay appended.
      expect(second.entries.length).toBe(first.entries.length);
      expect(second.effects).toEqual(first.effects);
    },
  );

  it("runs no side effect on the second pass", async () => {
    const crashed = runToCrash(5);
    const before = readEffects(crashed.effectsLog).length;

    await recover(crashed);
    await recover(crashed);
    await recover(crashed);

    // Three recoveries, still at most the one execution the crashed run performed.
    expect(readEffects(crashed.effectsLog).length).toBe(before);
  });

  it("refuses a duplicate settlement under an already-used reserved id", async () => {
    const crashed = runToCrash(9);
    await recover(crashed);

    const { store, close } = await inspect(crashed);
    try {
      const settled = store.entriesFrom(0).filter((e) => e.run_id === RUN);
      // Two separate uniqueness rules, checked separately — a single `new Set(seqs)` check
      // silently COLLAPSED the many null seqs of store entries and reported them as
      // duplicates, so it was asserting the wrong thing entirely.
      const seqs = settled.map((e) => e.seq).filter((v): v is number => v !== null);
      expect(new Set(seqs).size, "duplicate event seq").toBe(seqs.length);

      const keys = settled.map((e) => e.settlement_key).filter((v): v is string => v !== null);
      // The one that matters here: the executor does not check first, it writes and lets
      // UNIQUE (run_id, settlement_key) reject the second attempt.
      expect(new Set(keys).size, "duplicate settlement").toBe(keys.length);
    } finally {
      await close();
    }
  });

  it("re-settling a position that was already settled leaves ONE entry", async () => {
    const crashed = runToCrash(9);
    await recover(crashed);

    const { store, close } = await inspect(crashed);
    try {
      const before = store.entriesFrom(0).length;
      // Rewind the marker by hand — the state a crash between the settlement write and
      // the position write would leave behind. The key must be the one the settlement
      // ACTUALLY used; a different key is a different settlement and would legitimately
      // write, which is the point of moving the identity off the seq.
      const position = checkpoint.read(store, RUN);
      if (position?.phase !== "terminal") throw new Error("expected a terminal position");
      const settled = store
        .entriesFrom(0)
        .find((e) => e.run_id === RUN && e.settlement_key !== null);
      if (!settled?.settlement_key) throw new Error("no settlement to replay");
      checkpoint.write(store, RUN, {
        phase: "request_pending",
        settlementKey: settled.settlement_key,
        reservedUsageId: 1,
        requestSnapshotId: "s",
        attempt: 1,
        maxAttempts: 3,
        notBeforeMs: 0,
      });

      await applyRecovery(store, RUN, { now: () => 1_700_000_000_000 });

      // The key is already used, so UNIQUE (run_id, settlement_key) drops the duplicate.
      expect(store.entriesFrom(0).length).toBe(before);
    } finally {
      await close();
    }
  });
});
