import { describe, expect, it, vi } from "vitest";
import {
  ExtensionRegistry,
  ON_FAILURE,
  PRIORITY,
  type PointName,
  TIMEOUT_MS,
} from "../../src/extensions/points.js";

/**
 * every point is time-bounded, and the two bands FAIL IN OPPOSITE DIRECTIONS.
 *
 * `points.test.ts` proves a hung `tool:before` refuses. The complementary half was untested: a
 * hung TRANSFORM must be abandoned and the run must carry on, and a timeout is a different code
 * path from a throw (`withTimeout` rejects from a timer, not from the handler). A registry that
 * failed closed everywhere would pass the existing test and silently turn every slow observer
 * into a blocked run.
 *
 * The asymmetry is asserted as a PAIR here, because that pairing IS the requirement — "fails
 * closed" and "fails open" are only meaningful relative to each other, and checking one alone is
 * how a uniform-failure regression would slip through.
 */

const CTX = {
  "request:before": { model: "m", system: "S", messages: [], tools: [] },
  "tool:before": { toolUseId: "tu_1", name: "bash", input: {}, cwd: "/w", runId: "1" },
  "tool:after": { toolUseId: "tu_1", name: "bash", result: { content: [], isError: false } },
  "run:complete": { runId: "1", outcome: "finished", uncertain: false, turns: 1 },
  // biome-ignore lint/suspicious/noExplicitAny: one context per point, shapes differ by design
} as any;

const POINTS: PointName[] = ["request:before", "tool:before", "tool:after", "run:complete"];

function hangingAt(point: PointName): ExtensionRegistry {
  return new ExtensionRegistry().register({
    id: "hanger",
    point,
    priority: PRIORITY.thirdPartyPlugin,
    run: () => new Promise(() => {}) as never,
    // biome-ignore lint/suspicious/noExplicitAny: one shape for all four points
  } as any);
}

/** Dispatch, push time past the point's bound, and return the settled result. */
async function dispatchPastBound(registry: ExtensionRegistry, point: PointName) {
  vi.useFakeTimers();
  try {
    const dispatched = registry.dispatch(point, CTX[point]);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS[point] + 10);
    return await dispatched;
  } finally {
    vi.useRealTimers();
  }
}

describe("every point is bounded", () => {
  for (const point of POINTS) {
    it(`abandons a hanging handler at ${point}'s bound instead of waiting forever`, async () => {
      // The promise is not cancellable — the handler may keep running — but the LOOP stops
      // waiting, which is the whole purpose of the bound.
      const result = await dispatchPastBound(hangingAt(point), point);

      expect(result.failed).toEqual(["hanger"]);
    });
  }

  it("declares a bound for every point, so a new point cannot arrive unbounded", () => {
    // A point missing from this table would time out at `undefined` ms — which `setTimeout`
    // treats as 0, firing immediately and refusing every gated call.
    for (const point of POINTS) {
      expect(TIMEOUT_MS[point], point).toBeGreaterThan(0);
    }
  });
});

describe("the two bands fail in opposite directions", () => {
  it("tool:before REFUSES on timeout", async () => {
    const result = await dispatchPastBound(hangingAt("tool:before"), "tool:before");

    // A hung approval gate must not permit the command it was installed to gate.
    expect(result.outcome.k).toBe("refuse");
  });

  for (const point of ["request:before", "tool:after", "run:complete"] as const) {
    it(`${point} CONTINUES on timeout, so a slow observer cannot block the run`, async () => {
      const result = await dispatchPastBound(hangingAt(point), point);

      expect(result.outcome.k).toBe("continue");
    });
  }

  it("keeps exactly one point failing closed", () => {
    // Stated as a count, so adding a second fail-closed point is a deliberate edit here rather
    // than an accident that quietly widens what can block a run.
    const closed = POINTS.filter((point) => ON_FAILURE[point] === "refuse");
    expect(closed).toEqual(["tool:before"]);
  });

  it("passes the ORIGINAL context through when a transform times out", async () => {
    const registry = hangingAt("request:before").register({
      id: "later",
      point: "request:before",
      priority: PRIORITY.thirdPartyPlugin + 1,
      run: (ctx) => ({ k: "continue", value: { ...ctx, system: `${ctx.system}!` } }),
    });

    const result = await dispatchPastBound(registry, "request:before");

    // The abandoned handler contributes nothing, and the handlers after it still run — otherwise
    // one slow plugin would silently disable every plugin behind it.
    expect(result.outcome.k).toBe("continue");
    if (result.outcome.k === "continue") {
      expect((result.outcome.value as { system: string }).system).toBe("S!");
    }
  });
});

describe("a handler that finishes inside its bound", () => {
  it("is not abandoned", async () => {
    vi.useFakeTimers();
    try {
      const registry = new ExtensionRegistry().register({
        id: "prompt",
        point: "tool:before",
        priority: PRIORITY.bundled,
        run: async (ctx) => {
          await new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS["tool:before"] - 100));
          return { k: "continue", value: ctx };
        },
      });

      const dispatched = registry.dispatch("tool:before", CTX["tool:before"]);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS["tool:before"] - 50);
      const result = await dispatched;

      // The bound is generous BECAUSE `tool:before` may await a human; a gate that refused a
      // 29-second approval would make the extra time pointless.
      expect(result.outcome.k).toBe("continue");
      expect(result.failed).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
