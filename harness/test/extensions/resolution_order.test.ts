import { describe, expect, it } from "vitest";
import {
  ExtensionRegistry,
  type Outcome,
  PRIORITY,
  type ToolCallCtx,
} from "../../src/extensions/points.js";

/**
 * two handlers on ONE DECISION resolve by the documented rule.
 *
 * `points.test.ts` traces the ORDER handlers run in. This covers what happens when they
 * DISAGREE, which is what  is about: order alone says nothing about who wins, and a
 * registry could visit handlers in the right sequence and still let the last one overturn a
 * refusal.
 *
 * The documented rules, each asserted below:
 *   1. refusal WINS and short-circuits — a later handler cannot un-refuse;
 *   2. `replace` short-circuits too, so the substitute is not re-transformed;
 *   3. bands run ascending (bundled → first-party → third-party), so a third-party plugin can
 *      never pre-empt a bundled policy;
 *   4. within a band, registration order — the documented tie-break — and NEVER load order.
 *
 * Rule 3 is the security-relevant one: if third-party ran first it could `replace` a call and
 * short-circuit the bundled gate entirely, which is the bypass the band order exists to prevent.
 */

const call = (over: Partial<ToolCallCtx> = {}): ToolCallCtx => ({
  toolUseId: "tu_1",
  name: "bash",
  input: { command: "rm -rf /" },
  cwd: "/w",
  runId: "1",
  ...over,
});

function handler(
  id: string,
  priority: number,
  run: (ctx: ToolCallCtx) => Outcome<ToolCallCtx> | Promise<Outcome<ToolCallCtx>>,
) {
  return { id, point: "tool:before" as const, priority, run };
}

describe("a refusal against a permit", () => {
  it("refuses, whichever order they were registered in", async () => {
    for (const reversed of [false, true]) {
      const refuser = handler("refuser", PRIORITY.bundled, () => ({
        k: "refuse" as const,
        reason: "policy",
      }));
      const permitter = handler("permitter", PRIORITY.thirdPartyPlugin, (ctx) => ({
        k: "continue" as const,
        value: ctx,
      }));

      const registry = new ExtensionRegistry();
      // Registration order is varied deliberately: the outcome must come from the BAND, not
      // from which register() call happened to run first.
      for (const h of reversed ? [permitter, refuser] : [refuser, permitter]) registry.register(h);

      const result = await registry.dispatch("tool:before", call());
      expect(result.outcome.k, `reversed=${reversed}`).toBe("refuse");
      expect(result.by).toBe("refuser");
    }
  });

  it("does not run the handlers after the refusal at all", async () => {
    const seen: string[] = [];
    const registry = new ExtensionRegistry()
      .register(handler("refuser", PRIORITY.bundled, () => ({ k: "refuse", reason: "policy" })))
      .register(
        handler("after", PRIORITY.thirdPartyPlugin, (ctx) => {
          seen.push("after");
          return { k: "continue", value: ctx };
        }),
      );

    await registry.dispatch("tool:before", call());

    // Short-circuit is not an optimisation: a refused call must not reach code that could
    // observe its arguments.
    expect(seen).toEqual([]);
  });
});

describe("a third-party handler cannot pre-empt a bundled one", () => {
  it("runs the bundled gate first even when third-party registered first", async () => {
    const seen: string[] = [];
    const registry = new ExtensionRegistry()
      .register(
        handler("third-party", PRIORITY.thirdPartyPlugin, (ctx) => {
          seen.push("third-party");
          return { k: "continue", value: ctx };
        }),
      )
      .register(
        handler("bundled-gate", PRIORITY.bundled, (ctx) => {
          seen.push("bundled-gate");
          return { k: "continue", value: ctx };
        }),
      );

    await registry.dispatch("tool:before", call());

    expect(seen).toEqual(["bundled-gate", "third-party"]);
  });

  it("cannot short-circuit the bundled gate with a replace", async () => {
    let gateSaw = false;
    const registry = new ExtensionRegistry()
      .register(
        handler("bundled-gate", PRIORITY.bundled, () => {
          gateSaw = true;
          return { k: "refuse", reason: "policy" };
        }),
      )
      .register(
        handler("sneaky", PRIORITY.thirdPartyPlugin, () => ({
          k: "replace",
          value: call({ input: { command: "echo safe" } }),
        })),
      );

    const result = await registry.dispatch("tool:before", call());

    // If bands ran in the other order, `replace` would short-circuit and the gate would never
    // see the call — the bypass  is about.
    expect(gateSaw).toBe(true);
    expect(result.outcome.k).toBe("refuse");
  });
});

describe("replace against a transform", () => {
  it("short-circuits, so the substitute is not further transformed", async () => {
    const registry = new ExtensionRegistry()
      .register(
        handler("replacer", PRIORITY.bundled, () => ({
          k: "replace",
          value: call({ name: "read" }),
        })),
      )
      .register(
        handler("transform", PRIORITY.thirdPartyPlugin, (ctx) => ({
          k: "continue",
          value: { ...ctx, name: `${ctx.name}-touched` },
        })),
      );

    const result = await registry.dispatch("tool:before", call());

    expect(result.outcome.k).toBe("replace");
    if (result.outcome.k === "replace") {
      expect(result.outcome.value.name).toBe("read");
    }
    expect(result.by).toBe("replacer");
  });
});

describe("two handlers in the SAME band", () => {
  it("resolves by registration order, the documented tie-break", async () => {
    const seen: string[] = [];
    const trace = (id: string) =>
      handler(id, PRIORITY.firstPartyPlugin, (ctx) => {
        seen.push(id);
        return { k: "continue", value: ctx };
      });

    const registry = new ExtensionRegistry()
      .register(trace("first"))
      .register(trace("second"))
      .register(trace("third"));

    await registry.dispatch("tool:before", call());

    // A stable sort is what makes this true; an unstable one would reorder equal priorities
    // arbitrarily and the tie-break would stop being documented in any useful sense.
    expect(seen).toEqual(["first", "second", "third"]);
  });

  it("lets the FIRST-registered of two conflicting same-band handlers decide", async () => {
    const registry = new ExtensionRegistry()
      .register(handler("early-refuse", PRIORITY.bundled, () => ({ k: "refuse", reason: "no" })))
      .register(handler("late-permit", PRIORITY.bundled, (ctx) => ({ k: "continue", value: ctx })));

    const result = await registry.dispatch("tool:before", call());

    expect(result.by).toBe("early-refuse");
  });
});

describe("the bands themselves", () => {
  it("are ordered bundled < first-party < third-party", () => {
    // The numeric gaps exist so a band can be inserted without renumbering, but the ORDER is
    // the contract: least-trusted last.
    expect(PRIORITY.bundled).toBeLessThan(PRIORITY.firstPartyPlugin);
    expect(PRIORITY.firstPartyPlugin).toBeLessThan(PRIORITY.thirdPartyPlugin);
  });
});
