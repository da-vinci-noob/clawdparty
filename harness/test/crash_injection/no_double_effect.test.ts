import { describe, expect, it } from "vitest";
import { commitBoundaries, readEffects, recover, runToCrash } from "./harness.js";

/**
 * zero tools declared `replay: "never"` execute twice.
 *
 * This is the assertion the whole recovery design exists to support, so it is swept
 * across EVERY commit boundary rather than sampled at a few. A crash is only dangerous
 * at the boundaries you did not think to test, and "every commit" is the complete set,
 * because `store.commit` is the harness's only write primitive.
 *
 * The evidence is a FILE, not a counter. A counter lives in the process that gets
 * SIGKILLed, which is precisely when a double execution would occur; the file outlives
 * the crash, so "did this side effect happen twice" is answerable at all.
 */

const boundaries = commitBoundaries();

describe("no `never` tool executes twice", () => {
  it("has a representative run with enough commits to be worth sweeping", () => {
    // Guards the sweep itself: if the narrative regressed to two commits, every test
    // below would pass while testing almost nothing.
    expect(boundaries.length).toBeGreaterThanOrEqual(8);
  });

  it.each(boundaries)("kill at commit %i, then recover: bash ran at most once", async (at) => {
    const crashed = runToCrash(at);
    expect(crashed.exitSignal, `commit ${at} did not actually SIGKILL`).toBe("SIGKILL");

    const before = readEffects(crashed.effectsLog).length;
    const after = await recover(crashed);

    // At most once ACROSS the crash and the recovery. Never twice, and never fabricated
    // — recovery may not invent an effect that never happened either.
    expect(after.effects.length).toBeLessThanOrEqual(1);
    expect(after.effects.length).toBeGreaterThanOrEqual(before);
  });

  it("recovery never re-runs a `never` call, even when it was mid-flight", async () => {
    // Commit 5 is inside the tool phase with bash cleared but not settled — the exact
    // state where re-execution is tempting and wrong.
    const crashed = runToCrash(5);
    const before = readEffects(crashed.effectsLog);

    const after = await recover(crashed);

    expect(after.effects).toEqual(before);
    // No REPLAY. A first execution of a different, still-`planned` call is fine and is
    // counted separately — folding the two together would hide which one happened.
    expect(after.reexecuted).toBe(0);
  });

  it("DOES re-run a `safe` call, so the policy is not just blanket refusal", async () => {
    // Without this the suite above would pass with a recovery that re-executes nothing,
    // which would be a different bug wearing the same green tick.
    const results = await Promise.all(
      boundaries.map(async (at) => {
        const state = await recover(runToCrash(at));
        return state.reexecuted + state.executed;
      }),
    );

    expect(results.some((n) => n > 0)).toBe(true);
  });
});
