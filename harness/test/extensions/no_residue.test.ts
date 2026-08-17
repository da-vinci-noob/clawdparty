import { describe, expect, it } from "vitest";
import {
  ExtensionRegistry,
  type Outcome,
  PRIORITY,
  STRIKE_LIMIT,
  type ToolCallCtx,
} from "../../src/extensions/points.js";

/**
 * unregistering removes EVERY binding, and leaves no history behind.
 *
 * `points.test.ts` proves the bindings go. Two claims the code makes were untested, and both are
 * about the state that is NOT a binding:
 *
 *   * strikes are cleared, "so a re-enabled plugin is not disabled by a previous session's
 *     history". Asserting `handlersFor` is empty cannot show this — the handler is gone either
 *     way. The failure it hides is a plugin that installs, works, and is silently inert.
 *   * the auto-disabled flag is cleared. `disabled` is a separate set from `strikes`, so
 *     forgetting either one produces the same symptom by a different route.
 *
 * "Removes every binding" also has to mean OTHER contributors survive: a removal that took a
 * neighbour's handlers with it would satisfy a naive reading and break the room.
 */

const call = (): ToolCallCtx => ({
  toolUseId: "tu_1",
  name: "bash",
  input: {},
  cwd: "/w",
  runId: "1",
});

function handler(
  id: string,
  point: "tool:before" | "tool:after" | "run:complete" | "request:before",
  run: (ctx: never) => Outcome<never> | Promise<Outcome<never>>,
) {
  // biome-ignore lint/suspicious/noExplicitAny: one helper across heterogeneous points
  return { id, point, priority: PRIORITY.thirdPartyPlugin, run } as any;
}

const passthrough = (ctx: never) => ({ k: "continue" as const, value: ctx });
const thrower = () => {
  throw new Error("boom");
};

/** Strike a contributor up to the limit so it auto-disables. */
async function disableByFailing(registry: ExtensionRegistry, id: string): Promise<void> {
  for (let i = 0; i < STRIKE_LIMIT; i += 1) {
    await registry.dispatch("tool:after", {
      toolUseId: "tu_1",
      name: "bash",
      result: { content: [], isError: false },
    });
  }
  if (!registry.isDisabled(id)) throw new Error("setup failed: contributor was not disabled");
}

describe("every binding, across every point", () => {
  it("removes a contributor registered at all four points", async () => {
    const registry = new ExtensionRegistry();
    for (const point of ["request:before", "tool:before", "tool:after", "run:complete"] as const) {
      registry.register(handler("everywhere", point, passthrough));
    }

    registry.unregister("everywhere");

    // A partial removal is worse than none: the plugin looks uninstalled and still runs.
    for (const point of ["request:before", "tool:before", "tool:after", "run:complete"] as const) {
      expect(registry.handlersFor(point), point).toEqual([]);
    }
  });

  it("leaves other contributors' bindings intact", async () => {
    const registry = new ExtensionRegistry()
      .register(handler("gone", "tool:before", passthrough))
      .register(handler("stays", "tool:before", passthrough))
      .register(handler("stays", "tool:after", passthrough));

    registry.unregister("gone");

    expect(registry.handlersFor("tool:before")).toEqual(["stays"]);
    expect(registry.handlersFor("tool:after")).toEqual(["stays"]);
  });

  it("is a no-op for an id that was never registered", () => {
    const registry = new ExtensionRegistry().register(handler("real", "tool:before", passthrough));

    registry.unregister("never-installed");

    expect(registry.handlersFor("tool:before")).toEqual(["real"]);
  });
});

describe("the history is cleared too", () => {
  it("clears the auto-disabled flag, so a re-registered contributor RUNS", async () => {
    const registry = new ExtensionRegistry();
    registry.register(handler("flaky", "tool:after", thrower));
    await disableByFailing(registry, "flaky");

    registry.unregister("flaky");
    registry.register(handler("flaky", "tool:after", passthrough));

    // The symptom this catches: a plugin that installs cleanly, reports no error, and is inert.
    expect(registry.isDisabled("flaky")).toBe(false);
    expect(registry.handlersFor("tool:after")).toEqual(["flaky"]);
  });

  it("clears the strike COUNT, not just the flag", async () => {
    const registry = new ExtensionRegistry();
    registry.register(handler("flaky", "tool:after", thrower));
    // One short of the limit — enough to prove the counter survived, if it did.
    for (let i = 0; i < STRIKE_LIMIT - 1; i += 1) {
      await registry.dispatch("tool:after", {
        toolUseId: "tu_1",
        name: "bash",
        result: { content: [], isError: false },
      });
    }
    expect(registry.isDisabled("flaky")).toBe(false);

    registry.unregister("flaky");
    registry.register(handler("flaky", "tool:after", thrower));

    // With the count kept, ONE failure would now disable it — a fresh install inheriting a
    // previous session's history, which is exactly what  forbids.
    await registry.dispatch("tool:after", {
      toolUseId: "tu_1",
      name: "bash",
      result: { content: [], isError: false },
    });
    expect(registry.isDisabled("flaky")).toBe(false);
  });

  it("does not clear ANOTHER contributor's strikes", async () => {
    const registry = new ExtensionRegistry();
    registry.register(handler("flaky", "tool:after", thrower));
    registry.register(handler("other", "tool:before", passthrough));
    await disableByFailing(registry, "flaky");

    registry.unregister("other");

    // Removal is scoped to one id. Clearing the whole map would silently re-enable a
    // contributor the registry had already judged unreliable.
    expect(registry.isDisabled("flaky")).toBe(true);
  });
});

describe("dispatch after removal", () => {
  it("behaves exactly as if the contributor never existed", async () => {
    const registry = new ExtensionRegistry();
    registry.register(handler("refuser", "tool:before", () => ({ k: "refuse", reason: "no" })));

    registry.unregister("refuser");
    const result = await registry.dispatch("tool:before", call());

    expect(result.outcome.k).toBe("continue");
    expect(result.by).toBeUndefined();
    expect(result.failed).toEqual([]);
  });
});
