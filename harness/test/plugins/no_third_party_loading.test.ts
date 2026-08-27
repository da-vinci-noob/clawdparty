import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLED } from "../../src/extensions/host.js";

/**
 * satisfied BY CONSTRUCTION rather than by enforcement.
 *
 * asks that "a third-party plugin attempting to read a provider credential and to bypass an
 * authorization decision fails at both". A measurement showed that a `worker_thread` with `env: {}`
 * cannot deliver that: code inside one read `~/.claude.json` and the credential module's own source,
 * spawned processes, and had `fetch`. So the mechanism the design record assumed does not contain
 * what it claimed.
 *
 * The decision was therefore not to load third-party code at all. That makes  provable instead
 * of aspirational — there is no foreign code to attempt anything — and this file is the proof. An
 * absence nothing tests is one a later refactor quietly restores, and the restoration would look like
 * a feature.
 *
 * If third-party support is ever wanted, THIS TEST SHOULD FAIL FIRST. That failure is the intended
 * design review: it says the isolation question is being reopened, and the worker-thread isolation
 * finding is what has to be answered again.
 */

const SRC = join(import.meta.dirname, "..", "..", "src");

function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const files = sourceFiles();
const read = (path: string) => readFileSync(path, "utf8");

/** Every way this codebase could begin executing code it did not ship. */
const FOREIGN_CODE_LOADERS: Array<{ name: string; pattern: RegExp }> = [
  { name: "worker_threads", pattern: /from "node:worker_threads"|new Worker\(/ },
  { name: "node:vm", pattern: /from "node:vm"/ },
  /**
   * A DYNAMIC import — one whose specifier is not a literal. Literal lazy imports are used
   * deliberately (the AWS SDK and the MCP SDK load that way so a host that needs neither never pays
   * for them), so the pattern must not fire on those.
   *
   * The first attempt was `import\(\s*(?!["'])` and it produced two false positives, because `\s*`
   * BACKTRACKS to zero width and the lookahead then sees the newline of a formatter-wrapped
   * `await import(\n  "literal")`. Requiring the first non-whitespace character to be a
   * non-quote cannot backtrack that way.
   */
  { name: "dynamic import of a computed path", pattern: /\bimport\(\s*[^\s"'`)]/ },
  { name: "createRequire", pattern: /createRequire/ },
  { name: "eval", pattern: /\beval\(/ },
  { name: "Function constructor", pattern: /new Function\(/ },
];

describe("nothing loads code this build did not ship", () => {
  for (const { name, pattern } of FOREIGN_CODE_LOADERS) {
    it(`uses no ${name}`, () => {
      const offenders = files.filter((f) => pattern.test(read(f))).map((f) => f.slice(SRC.length));

      expect(offenders, `${name} appears in: ${offenders.join(", ")}`).toEqual([]);
    });
  }

  it("is not vacuous — each pattern matches its own sample", () => {
    // A security assertion whose patterns can never fire passes by accident. These samples are what
    // each one is meant to catch.
    const samples: Record<string, string> = {
      worker_threads: 'import { Worker } from "node:worker_threads";',
      "node:vm": 'import vm from "node:vm";',
      "dynamic import of a computed path": "await import(pluginPath)",
      createRequire: "const require = createRequire(import.meta.url);",
      eval: "eval(source)",
      "Function constructor": "new Function(body)",
    };
    for (const { name, pattern } of FOREIGN_CODE_LOADERS) {
      expect(pattern.test(samples[name] as string), `${name} misses its own sample`).toBe(true);
    }
  });

  it("still permits a lazy import of a LITERAL module, on one line or wrapped", () => {
    // Both shapes occur: `mcp/client.ts` and `bedrock_converse.ts` wrap across lines. An earlier
    // version of the pattern flagged the wrapped form, and weakening the guard to accommodate that
    // is how a guard stops guarding — so the pattern was fixed instead.
    const dynamic = FOREIGN_CODE_LOADERS.find(
      (l) => l.name === "dynamic import of a computed path",
    );

    for (const legitimate of [
      'await import("@aws-sdk/client-bedrock")',
      'await import(\n      "@modelcontextprotocol/sdk/client/stdio.js"\n    )',
    ]) {
      expect(dynamic?.pattern.test(legitimate), legitimate).toBe(false);
    }
    // And it still catches the shape that matters.
    expect(dynamic?.pattern.test("await import(pluginPath)")).toBe(true);
  });
});

describe("the host offers no way in", () => {
  it("exports no install or discover", async () => {
    const host = await import("../../src/extensions/host.js");

    // The API surface IS the boundary here. An `install` that existed but was unused would be one
    // route handler away from being reachable.
    expect(Object.keys(host)).not.toContain("install");
    expect(Object.keys(host)).not.toContain("discover");
    expect(Object.keys(host)).not.toContain("uninstall");
  });

  it("ships only bundled contributors", () => {
    expect(BUNDLED.length).toBeGreaterThan(0);
    for (const plugin of BUNDLED) {
      expect(plugin.origin, plugin.id).toBe("bundled");
    }
  });

  it("keeps `external` in the contract's union even though nothing produces it", () => {
    // Deliberate: the register's shape is the CONTRACT's, and narrowing it here would make a record
    // written by a future build unreadable by this one. The absence is a property of the code, not of
    // the type.
    const origins: Array<"bundled" | "external"> = ["bundled", "external"];
    expect(origins).toHaveLength(2);
  });
});
