import { describe, expect, it } from "vitest";
import { commitBoundaries, recover, runToCrash } from "./harness.js";

/**
 * a kill inside `request_pending` is reported as UNCERTAIN,
 * never as an assumed success or failure.
 *
 * The temptation is to pick one. "Failed" reads safer and is a lie: the request may have
 * been billed and may have produced output nobody recorded. "Finished" is the same lie
 * pointing the other way. The room is owed the truth that the outcome is unknown, which
 * is the one thing neither guess can express.
 */

const boundaries = commitBoundaries();

describe("uncertainty is stated, not guessed", () => {
  it("reports uncertain for at least one boundary — the request window exists", async () => {
    const states = await Promise.all(boundaries.map(async (at) => recover(runToCrash(at))));

    // If no boundary produced uncertainty, the sweep never entered the window and every
    // assertion below would be vacuous.
    expect(states.some((s) => s.uncertain)).toBe(true);
  });

  it("marks the settlement uncertain in the RECORD, not only in the return value", async () => {
    const states = await Promise.all(boundaries.map(async (at) => recover(runToCrash(at))));
    const uncertain = states.find((s) => s.uncertain);
    if (!uncertain) throw new Error("no uncertain boundary found");

    // A return value is gone once the process exits. The feed reads the record, so the
    // uncertainty has to be durable or the room never learns of it.
    const settled = uncertain.entries.find(
      (e) => (e.payload as { uncertain?: boolean }).uncertain === true,
    );
    expect(settled).toBeDefined();
    expect(settled?.type).toBe("run_interrupted");
  });

  it("never claims a stop reason for a request whose fate is unknown", async () => {
    const states = await Promise.all(boundaries.map(async (at) => recover(runToCrash(at))));
    const uncertain = states.find((s) => s.uncertain);
    if (!uncertain) throw new Error("no uncertain boundary found");

    const settled = uncertain.entries.find(
      (e) => (e.payload as { uncertain?: boolean }).uncertain === true,
    );
    const payload = settled?.payload as Record<string, unknown>;
    // `end_turn` / `max_tokens` would each assert something about output nobody saw.
    expect(payload.stop_reason).toBeUndefined();
    expect(payload.reason).toBe("harness_restart");
  });

  it("keeps the uncertain turn off the model-visible surface", async () => {
    const states = await Promise.all(boundaries.map(async (at) => recover(runToCrash(at))));
    const uncertain = states.find((s) => s.uncertain);
    if (!uncertain) throw new Error("no uncertain boundary found");

    const settled = uncertain.entries.find(
      (e) => (e.payload as { uncertain?: boolean }).uncertain === true,
    );
    // On the surface it would be replayed to the model as a real assistant turn whose
    // content nobody knows.
    expect(settled?.on_surface).toBe(0);
  });

  it("does NOT mark uncertainty for a crash outside the request window", async () => {
    // Killing in the tool phase has a knowable outcome per call, so reporting it as
    // uncertain would make the flag meaningless by crying wolf.
    const state = await recover(runToCrash(5));
    expect(state.uncertain).toBe(false);
  });
});
