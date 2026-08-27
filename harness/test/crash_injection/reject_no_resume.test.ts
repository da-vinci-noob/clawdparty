import { describe, expect, it } from "vitest";
import * as checkpoint from "../../src/loop/checkpoint.js";
import { applyRecovery } from "../../src/store/recovery.js";
import { RUN, inspect, runToCrash } from "./harness.js";

/**
 * recovery must not resurrect resumed context for a run whose change was
 * REJECTED.
 *
 * Reject reverts the worktree (`git reset --hard && git clean -fd`), so the recorded
 * conversation describes edits that no longer exist on disk. Resuming it would have
 * Claude reason confidently about files it cannot see, and the log alone cannot tell you
 * that happened — which is why the rule lives in the surface baseline rather than in a
 * deletion. The log is never deleted; the next request simply starts folding after it.
 *
 * The reason this needs a test HERE and not only in Rails: recovery is the one code path
 * that resumes a run WITHOUT going through `Runs::Start`, so it is the one place the rule
 * could be bypassed without anyone editing the rule.
 */

describe("recovery does not resurrect a rejected run's context", () => {
  it("never MOVES the lane leaf, which is what decides the surface", async () => {
    const crashed = runToCrash(5);
    const { store, close } = await inspect(crashed);

    try {
      // The baseline rides on `lane.leaf` plus the run's `surfaceFrom`; reject severs the
      // chain by moving that boundary forward. Recovery must treat it as a floor, not
      // recompute it.
      const before = store.readRegister("lane.leaf", "main");
      await applyRecovery(store, RUN, { now: () => 1_700_000_000_000 });
      const after = store.readRegister("lane.leaf", "main");

      expect(after).toEqual(before);
    } finally {
      await close();
    }
  });

  it("writes no register that could reopen a severed conversation", async () => {
    const crashed = runToCrash(9);
    const { store, close } = await inspect(crashed);

    try {
      await applyRecovery(store, RUN, { now: () => 1_700_000_000_000 });

      // Recovery's whole write surface is entries plus `run.position`. Touching the lane
      // registers would reach past its job into what the model can see, and touching
      // `run.meta` would let it rewrite the run's own identity.
      for (const ns of ["lane.leaf", "lane.state"] as const) {
        expect(
          store.readRegister(ns, "main"),
          `recovery wrote ${ns}, which decides what the model can see`,
        ).toBeNull();
      }
    } finally {
      await close();
    }
  });

  it("settles the uncertain turn OFF the surface, so it cannot be resumed into", async () => {
    const crashed = runToCrash(9);
    const { store, close } = await inspect(crashed);

    try {
      const outcome = await applyRecovery(store, RUN, { now: () => 1_700_000_000_000 });
      expect(outcome.uncertain).toBe(true);

      const settled = store
        .entriesFrom(0)
        .find((e) => (e.payload as { uncertain?: boolean }).uncertain === true);
      // Off the surface is what makes this safe under  as well as : a turn
      // nobody can describe is also a turn no later request should fold in.
      expect(settled?.on_surface).toBe(0);
    } finally {
      await close();
    }
  });

  it("leaves the run terminal so the next run goes through Runs::Start", async () => {
    const crashed = runToCrash(9);
    const { store, close } = await inspect(crashed);

    try {
      await applyRecovery(store, RUN, { now: () => 1_700_000_000_000 });

      // Terminal means recovery hands control back to Rails, which is where the
      // reject-severs-resume rule is enforced (`Runs::Start#resume_context?`). If
      // recovery resumed the loop itself it would bypass that decision entirely.
      expect(checkpoint.read(store, RUN)).toEqual({ phase: "terminal", outcome: "interrupted" });
    } finally {
      await close();
    }
  });
});
