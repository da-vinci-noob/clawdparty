import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * "a contributor can add a new rule that refuses a specific command, and the
 * resulting change set touches no run-loop file."
 *
 * That is a claim about the SHAPE OF A DIFF, which no behavioural test can observe. What
 * can be observed is the property that makes it true: if `loop/` never references rules,
 * then adding one cannot require editing `loop/`. Asserted at the source, same genre as
 * `no_shell_input.test.ts` — it proves nothing was ADDED that couples the two, which is
 * the change worth catching.
 *
 * Both directions matter and they fail differently. A rule importing from `loop/` couples
 * the rule to the engine, so the engine cannot be refactored without touching every rule.
 * `loop/` importing a rule couples the engine to the rule SET, so adding a rule means
 * editing the loop — which is exactly what  forbids.
 */

const SRC = new URL("../../src/", import.meta.url).pathname;
const RULES = join(SRC, "extensions/rules");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    try {
      return sourceFiles(path);
    } catch {
      return path.endsWith(".ts") ? [path] : [];
    }
  });
}

const ruleFiles = readdirSync(RULES).filter((f) => f.endsWith(".ts"));
const loopFiles = sourceFiles(join(SRC, "loop"));

describe("a rule is decoupled from the run loop", () => {
  it("ships at least one rule, so this is not vacuously true", () => {
    expect(ruleFiles.length).toBeGreaterThan(0);
  });

  it.each(ruleFiles)("%s imports nothing from loop/", (file) => {
    const body = read(join(RULES, file));

    // A rule sees a context object and returns an Outcome. Reaching into the loop would
    // make the engine unrefactorable without touching every rule.
    expect(body, `${file} imports from loop/`).not.toMatch(/from "\.\.\/\.\.\/loop\//);
    expect(body).not.toMatch(/from "[^"]*\/run_loop/);
  });

  it("no loop/ file references the rules directory or any rule by name", () => {
    const offenders = loopFiles.filter((path) => {
      const body = read(path);
      return /extensions\/rules|deny_destructive_bash|bundledRules/.test(body);
    });

    // THE assertion behind. If the loop enumerated rules, adding one would mean
    // editing a loop file and the criterion would be false — no diff inspection needed to
    // know it.
    expect(offenders.map((p) => p.slice(SRC.length))).toEqual([]);
  });

  it("registers rules OUTSIDE the loop, at the supervisor", () => {
    const supervisor = read(join(SRC, "supervisor.ts"));

    // Where the wiring does live. Naming it keeps this test honest: the claim is "not in
    // the loop", not "nowhere" — a rule set has to be assembled somewhere, and a
    // contributor needs to know where without reading the loop.
    expect(supervisor).toMatch(/extensions\/rules\//);
  });

  it("a rule depends only on the published extension contract", () => {
    for (const file of ruleFiles) {
      const body = read(join(RULES, file));
      const imports = [...body.matchAll(/from "([^"]+)"/g)].map((m) => m[1] as string);

      // Every import is either the points contract or a node builtin. A bundled rule
      // taking a private path would make 's "no privileged path available only to
      // bundled code" false while still compiling.
      for (const spec of imports) {
        expect(
          spec.startsWith("node:") || spec.includes("points.js") || spec.includes("registry.js"),
          `${file} imports ${spec}, which is not part of the published contract`,
        ).toBe(true);
      }
    }
  });
});
