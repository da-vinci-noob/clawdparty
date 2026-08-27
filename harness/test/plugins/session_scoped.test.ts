import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_VERSION } from "@clawdparty/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUNDLED,
  activeFor,
  compatibility,
  descriptorFor,
  enablementWrites,
  handlersFor,
} from "../../src/extensions/host.js";
import { openStore } from "../../src/store/store.js";
import type { HarnessStoreApi } from "../../src/store/types.js";

/**
 * Enablement is per SESSION, durable, and leaves no residue.
 *
 * These are the properties  asked for that survive the option-A decision: they are facts about the
 * contributor SET, not about where its code came from. What is gone is third-party loading
 * (`no_third_party_loading.test.ts` asserts that absence) — and with it the worker boundary the
 * design record assumed, because a measurement showed that it contains only the environment.
 */

const A = "bundled:deny-destructive-bash";
const B = "bundled:deny-out-of-tree-write";

let dir: string;
let store: HarnessStoreApi;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "harness-plugins-"));
  const opened = await openStore("45", { dir, owner: "plugins" });
  if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
  store = opened.store;
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Apply an enablement the way the supervisor does — plan, then commit. */
function set(sessionId: string, id: string, enabled: boolean): void {
  const planned = enablementWrites(store, sessionId, id, enabled);
  if (!planned.ok) throw new Error(planned.reason);
  store.commit({ writes: planned.writes });
}

/** The descriptor, or a loud failure — `as never` cannot be spread, and a null here is a real bug. */
function descriptor(id: string) {
  const found = descriptorFor(id);
  if (found === null) throw new Error(`no descriptor for ${id}`);
  return found;
}

describe("defaults", () => {
  it("has every bundled contributor on before anyone chooses", () => {
    // A gate that is off until someone enables it would mean a fresh session runs ungated, which is
    // the opposite of what a bundled rule is for.
    expect(
      activeFor(store, "45")
        .map((p) => p.id)
        .sort(),
    ).toEqual([A, B].sort());
  });

  it("distinguishes NEVER CONFIGURED from configured-to-the-default", () => {
    expect(store.readRegister("session.plugins", "45")).toBeNull();

    set("45", A, true);

    // Written explicitly on the first change, so a later default change does not silently alter a
    // session someone had already reviewed.
    expect(store.readRegister("session.plugins", "45")).not.toBeNull();
  });
});

describe("scoped to one session", () => {
  it("disabling in session A leaves session B untouched", () => {
    set("A", A, false);

    expect(activeFor(store, "A").map((p) => p.id)).not.toContain(A);
    // One store serves the whole harness; a register keyed per session is what keeps one room's
    // choice out of another's.
    expect(activeFor(store, "B").map((p) => p.id)).toContain(A);
  });

  it("resolves handlers per session, so a disabled rule cannot fire", () => {
    set("A", A, false);

    expect(handlersFor(store, "A").map((h) => h.id)).toEqual([B]);
    expect(
      handlersFor(store, "B")
        .map((h) => h.id)
        .sort(),
    ).toEqual([A, B].sort());
  });

  it("leaves ZERO residual effect after disable", () => {
    set("A", A, false);
    set("A", A, true);

    // Re-enabling restores exactly the default set — no duplicate entry, no leftover ordering.
    expect(
      activeFor(store, "A")
        .map((p) => p.id)
        .sort(),
    ).toEqual([A, B].sort());
    const record = store.readRegister("session.plugins", "A") as Array<{ id: string }>;
    expect(record.filter((e) => e.id === A)).toHaveLength(1);
  });

  it("is idempotent — enabling twice does not duplicate", () => {
    set("A", A, true);
    set("A", A, true);

    const record = store.readRegister("session.plugins", "A") as Array<{ id: string }>;
    expect(record.filter((e) => e.id === A)).toHaveLength(1);
  });
});

describe("the record carries the DESCRIPTOR, not a reference", () => {
  it("stores id, version and origin", () => {
    set("A", A, true);

    // A session must stay readable after a contributor leaves the build, which means the record has
    // to say what it WAS rather than pointing at something that may be gone.
    expect(store.readRegister("session.plugins", "A")).toEqual(
      expect.arrayContaining([{ id: A, version: "1.0.0", origin: "bundled" }]),
    );
  });

  it("ignores an entry this build no longer ships, rather than crashing", () => {
    store.commit({
      writes: [
        {
          kind: "register",
          op: "set",
          namespace: "session.plugins",
          key: "A",
          value: [{ id: "bundled:removed-in-a-later-build", version: "0.9.0", origin: "bundled" }],
        },
      ],
    });

    // The run must still start. Resolving through `descriptorFor` is what makes an unknown entry
    // inert instead of fatal — and the register still holds it, so the record is not rewritten.
    expect(activeFor(store, "A")).toEqual([]);
    expect(store.readRegister("session.plugins", "A")).toHaveLength(1);
  });
});

describe("contract-version refusal", () => {
  it("accepts a contributor targeting this exact contract", () => {
    expect(compatibility(descriptor(A))).toEqual({ ok: true });
  });

  it("refuses a MAJOR mismatch, with a reason", () => {
    const stale = { ...descriptor(A), contractVersion: { major: 0, minor: 9 } };
    const result = compatibility(stale);

    // Never loaded and never silently downgraded: a contributor that half-works leaves the room
    // unable to tell which of its rules are in force.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/major difference is breaking/i);
  });

  it("refuses a contributor needing a NEWER minor than this build serves", () => {
    const future = {
      ...descriptor(A),
      contractVersion: { major: CONTRACT_VERSION.major, minor: CONTRACT_VERSION.minor + 1 },
    };
    const result = compatibility(future);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/upgrade the harness/i);
  });

  it("accepts an OLDER minor, since the contract is additive within a major", () => {
    const older = {
      ...descriptor(A),
      contractVersion: { major: CONTRACT_VERSION.major, minor: 0 },
    };
    expect(compatibility(older)).toEqual({ ok: true });
  });

  it("refuses the ENABLEMENT too, not just the compatibility check", () => {
    // The check has to be on the write path, or an incompatible contributor is refused in principle
    // and enabled in practice.
    const unknown = enablementWrites(store, "A", "bundled:does-not-exist", true);

    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.reason).toMatch(/unknown extension/);
    // And it names what IS available, so the caller can correct it.
    expect(unknown.reason).toContain(A);
  });
});

describe("the descriptor describes what the code actually does", () => {
  it("derives `contributes` from the handler, so it cannot over-claim", () => {
    for (const plugin of BUNDLED) {
      expect(plugin.contributes.length).toBeGreaterThan(0);
      // Both bundled rules are gates. A descriptor listing a point its handler never registers on
      // would tell the panel the rule can do something it cannot.
      expect(plugin.contributes).toEqual(["tool:before"]);
    }
  });

  it("gives every contributor a participant-facing summary", () => {
    for (const plugin of BUNDLED) {
      // The panel renders this verbatim; an id is not an explanation.
      expect(plugin.summary.length, plugin.id).toBeGreaterThan(30);
      expect(plugin.summary, plugin.id).not.toBe(plugin.id);
    }
  });

  it("has no duplicate ids, which would make enablement ambiguous", () => {
    const ids = BUNDLED.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * WHEN a toggle takes effect, which is a decision that was framed around the wrong constraint.
 *
 * The design record proposed branching on `Capabilities.midConversationToolChanges`: true → emit
 * `tool_addition`/`tool_removal` with `defer_loading`, false → enable at run start, citing R7's
 * cache-invalidation constraint. That constraint does not apply here. Bundled contributors register
 * HANDLERS at extension points, not tools — a `tool:before` gate changes nothing about the tool set
 * sent to the model, so there is no declaration to add or remove and no prompt-cache prefix to
 * invalidate.
 *
 * So the decision is simply: **enablement resolves at RUN START and takes effect on the next run.**
 * Three reasons, and the third is the one that makes it comfortable:
 *
 *  1. The request snapshot records which rules were in force. A set that changed mid-run
 *     would make "which rules applied to this tool call" ambiguous even with a fresh
 *     `request_header`, because the header is per-turn and a call is finer-grained than that.
 *  2. A run's behaviour should be explicable from one resolved scope, the same reason the tool set
 *     and the skill set are resolved once at start.
 *  3. The urgent case — "stop what is happening now" — is already served by INTERRUPT, which is
 *     immediate and unambiguous. A mid-run gate toggle would be a slower, vaguer version of it.
 */
describe("a toggle takes effect at the NEXT run start", () => {
  it("does not change the handler set already resolved for a live run", () => {
    // What the supervisor does at start: resolve once.
    const resolvedAtStart = handlersFor(store, "A").map((h) => h.id);
    expect(resolvedAtStart).toHaveLength(2);

    set("A", A, false);

    // The live run holds its own list; the register changing underneath it must not mutate that.
    expect(resolvedAtStart).toHaveLength(2);
    // And the NEXT resolution sees the change.
    expect(handlersFor(store, "A").map((h) => h.id)).toEqual([B]);
  });

  it("changes nothing about the TOOL set, which is why R7 does not apply", () => {
    // Contributors register at extension points. If a toggle altered the declared tools, the
    // prompt-cache prefix would shift and R7's constraint would bite — it does not, because no
    // bundled contributor contributes a tool.
    for (const plugin of BUNDLED) {
      expect(plugin.contributes.every((point) => point.includes(":"))).toBe(true);
      expect(plugin.contributes).not.toContain("tool");
    }
  });
});
