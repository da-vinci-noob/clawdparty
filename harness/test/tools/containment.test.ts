import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertWritable } from "../../src/tools/paths.js";
import * as read from "../../src/tools/read.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import * as textEditor from "../../src/tools/text_editor.js";

/**
 * Path containment for every tool that touches the filesystem.
 *
 * The rule must match Rails' `RepoPaths`/`RepoBrowser` exactly: a file the API
 * refuses to show must be a file a tool refuses to touch. A gap between the two
 * is worse than either being wrong alone, because a reviewer checking one would
 * conclude the other is covered.
 */

let root: string;
let outside: string;

function ctx() {
  return { cwd: root, runId: "run_1", signal: new AbortController().signal };
}

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "harness-contain-"));
  root = join(base, "worktree");
  outside = join(base, "outside");
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });

  writeFileSync(join(root, "src", "ok.ts"), "export const ok = 1;\n");
  writeFileSync(join(outside, "loot.txt"), "SECRET-OUTSIDE-THE-WORKTREE\n");
  writeFileSync(join(root, ".env"), "API_KEY=should-never-be-read\n");
  writeFileSync(join(root, "server.key"), "private key material\n");
  writeFileSync(join(root, "my_secret_notes.md"), "denylisted by basename\n");
});

afterEach(() => {
  rmSync(join(root, ".."), { recursive: true, force: true });
});

describe("read — containment", () => {
  it("reads a contained file", () => {
    const result = read.run({ path: "src/ok.ts" }, ctx());

    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain("export const ok = 1;");
  });

  // READS ARE NO LONGER CONTAINED.  requires that "100% of symlinks that leave
  // the project directory resolve correctly", which a pnpm store and `npm link` both
  // depend on, and model-directed `bash` can already read anything the developer can
  // (an accepted complexity tradeoff) — so refusing these protected nothing while
  // breaking ordinary repos. The DENYLIST is what protects reads, and the containment
  // rule these examples used to assert now lives on the WRITE path. See
  // test/tools/symlink_escape.test.ts for the read/write split in full.
  it("reads through a traversal, because reads follow the filesystem", () => {
    const result = read.run({ path: "../outside/loot.txt" }, ctx());

    expect(result.isError).toBe(false);
  });

  it("reads an absolute path outside the root", () => {
    const result = read.run({ path: join(outside, "loot.txt") }, ctx());

    expect(result.isError).toBe(false);
  });

  it("reads through a symlink leaving the root (the pnpm/npm-link case)", () => {
    symlinkSync(join(outside, "loot.txt"), join(root, "escape.txt"));

    const result = read.run({ path: "escape.txt" }, ctx());

    expect(result.isError).toBe(false);
  });

  it("still refuses a WRITE through a symlink leaving the root", () => {
    symlinkSync(join(outside, "loot.txt"), join(root, "escape.txt"));

    // The property the read examples used to carry, on the path where it matters:
    // reject reverts the worktree, so an edit outside it survives review.
    expect(() => assertWritable(root, join(root, "escape.txt"))).toThrow();
  });

  it("still refuses a WRITE via traversal out of the root", () => {
    expect(() => assertWritable(root, join(root, "..", "outside", "loot.txt"))).toThrow();
  });

  it("does not decode URL-encoded traversal into a real escape", () => {
    // `%2e%2e%2f` must be treated as a literal filename, never decoded to `../`.
    // Decoding somewhere in the stack is how a containment check gets bypassed
    // after it has already run.
    const result = read.run({ path: "%2e%2e%2f%2e%2e%2foutside%2floot.txt" }, ctx());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toContain("SECRET-OUTSIDE-THE-WORKTREE");
  });

  it("refuses each denylisted basename", () => {
    for (const path of [".env", "server.key", "my_secret_notes.md"]) {
      const result = read.run({ path }, ctx());
      expect(result.isError, `${path} should be refused`).toBe(true);
      expect(result.content[0]?.text).toContain("not available");
    }
  });

  it("refuses anything under .git", () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "config"), "[core]\n");

    expect(read.run({ path: ".git/config" }, ctx()).isError).toBe(true);
  });

  it("refuses a file over the 1MB cap", () => {
    writeFileSync(join(root, "big.txt"), "x".repeat(1024 * 1024 + 1));

    expect(read.run({ path: "big.txt" }, ctx()).content[0]?.text).toMatch(/exceeds/);
  });

  it("refuses binary content by null-byte detection", () => {
    writeFileSync(join(root, "bin.dat"), Buffer.from([0x41, 0x00, 0x42]));

    expect(read.run({ path: "bin.dat" }, ctx()).content[0]?.text).toMatch(/binary/);
  });
});

describe("text_editor — containment", () => {
  it("views a contained file", async () => {
    const result = await textEditor.run({ command: "view", path: "src/ok.ts" }, ctx());

    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain("export const ok = 1;");
  });

  it("views outside the root, since view is a read", async () => {
    const result = await textEditor.run({ command: "view", path: "../outside/loot.txt" }, ctx());

    expect(result.isError).toBe(false);
  });

  it("refuses str_replace on a file outside the root, because that is a write", async () => {
    const result = await textEditor.run(
      { command: "str_replace", path: "../outside/loot.txt", old_str: "SECRET", new_str: "x" },
      ctx(),
    );

    // view and str_replace differ on the SAME path: one reads, one edits. That
    // asymmetry is deliberate and is the thing worth pinning.
    expect(result.isError).toBe(true);
  });

  it("refuses insert on a file outside the root", async () => {
    const result = await textEditor.run(
      { command: "insert", path: "../outside/loot.txt", insert_line: 0, new_str: "x" },
      ctx(),
    );

    expect(result.isError).toBe(true);
  });

  it("refuses to CREATE outside the root", async () => {
    const result = await textEditor.run(
      { command: "create", path: "../outside/planted.txt", file_text: "nope" },
      ctx(),
    );

    expect(result.isError).toBe(true);
  });

  it("refuses to create through a symlinked directory that escapes", async () => {
    symlinkSync(outside, join(root, "linkdir"));

    const result = await textEditor.run(
      { command: "create", path: "linkdir/planted.txt", file_text: "nope" },
      ctx(),
    );

    expect(result.isError).toBe(true);
  });

  it("refuses to create a DENYLISTED file it could never read", async () => {
    // The asymmetry this guards: containForCreate cannot run the read pipeline on
    // a file that does not exist, so without an explicit denylist check a tool
    // could write `.env` while being unable to read one.
    const result = await textEditor.run(
      { command: "create", path: "config/.env.production", file_text: "API_KEY=x" },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not available");
  });

  it("creates a NEW file inside the root, and a new directory for it", async () => {
    const changed: Array<[string, string]> = [];
    const result = await textEditor.run(
      { command: "create", path: "src/nested/new.ts", file_text: "export const n = 2;\n" },
      { ...ctx(), onFileChanged: (p, c) => changed.push([p, c]) },
    );

    expect(result.isError).toBe(false);
    expect(changed).toEqual([["src/nested/new.ts", "created"]]);
  });

  it("reports overwriting an existing file as modified, not created", async () => {
    const changed: Array<[string, string]> = [];
    await textEditor.run(
      { command: "create", path: "src/ok.ts", file_text: "replaced\n" },
      { ...ctx(), onFileChanged: (p, c) => changed.push([p, c]) },
    );

    expect(changed).toEqual([["src/ok.ts", "modified"]]);
  });

  it("refuses an ambiguous str_replace rather than editing the first match", async () => {
    writeFileSync(join(root, "dupes.ts"), "const a = 1;\nconst a = 1;\n");

    const result = await textEditor.run(
      {
        command: "str_replace",
        path: "dupes.ts",
        old_str: "const a = 1;",
        new_str: "const b = 2;",
      },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/appears 2 times/);
  });
});

describe("replay policy", () => {
  it("is per-sub-command for text_editor: view is safe, writes are never", () => {
    const registry = new ToolRegistry().register(textEditor.definition);

    expect(registry.policyFor(textEditor.TEXT_EDITOR_TOOL_NAME, { command: "view" })).toBe("safe");
    for (const command of ["create", "str_replace", "insert"]) {
      expect(registry.policyFor(textEditor.TEXT_EDITOR_TOOL_NAME, { command })).toBe("never");
    }
  });

  it("defaults an UNKNOWN tool to never", () => {
    // Fail safe: a plugin-provided tool the registry has not seen must not be
    // assumed replayable, or a crash re-runs its side effect.
    expect(new ToolRegistry().policyFor("something-a-plugin-added")).toBe("never");
  });

  it("keeps bash at never and the read tools at safe", async () => {
    const { BashTool } = await import("../../src/tools/bash.js");
    const glob = await import("../../src/tools/glob.js");
    const grep = await import("../../src/tools/grep.js");
    const registry = new ToolRegistry()
      .register(new BashTool().definition)
      .register(read.definition)
      .register(glob.definition)
      .register(grep.definition);

    expect(registry.policyFor("bash")).toBe("never");
    expect(registry.policyFor("read")).toBe("safe");
    expect(registry.policyFor("glob")).toBe("safe");
    expect(registry.policyFor("grep")).toBe("safe");
  });
});

describe("canonical tool declarations", () => {
  it("declares bash and text_editor SCHEMA-LESS", async () => {
    const { BashTool } = await import("../../src/tools/bash.js");

    // Supplying an input_schema changes the tool's identity as far as the
    // provider is concerned, so its absence is the contract.
    expect(new BashTool().definition.schema).toEqual({ type: "bash_20250124", name: "bash" });
    expect(textEditor.definition.schema).toEqual({
      type: "text_editor_20250728",
      name: "str_replace_based_edit_tool",
    });
    expect(new BashTool().definition.schema.input_schema).toBeUndefined();
    expect(textEditor.definition.schema.input_schema).toBeUndefined();
  });

  it("withholds web tools from a provider that cannot serve them", async () => {
    const web = await import("../../src/tools/web.js");
    const registry = new ToolRegistry().register(read.definition);
    for (const tool of web.definitions) registry.register(tool);

    const withWeb = registry
      .schemasFor(caps({ webSearch: true, webFetch: true }))
      .map((s) => s.name);
    const withoutWeb = registry
      .schemasFor(caps({ webSearch: false, webFetch: false }))
      .map((s) => s.name);

    expect(withWeb).toContain("web_search");
    expect(withWeb).toContain("web_fetch");
    // Bedrock has neither. Declaring them anyway produces an opaque request
    // error rather than "this provider cannot search the web".
    expect(withoutWeb).not.toContain("web_search");
    expect(withoutWeb).not.toContain("web_fetch");
    expect(withoutWeb).toContain("read");
  });

  it("removes a disallowed tool entirely rather than merely un-approving it", () => {
    const registry = new ToolRegistry().register(read.definition);

    expect(registry.schemasFor(caps({}), ["read"])).toEqual([]);
  });
});

function caps(over: { webSearch?: boolean; webFetch?: boolean }) {
  return {
    streaming: true as const,
    toolUse: true as const,
    toolUseWhileStreaming: true,
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    adaptiveThinking: true,
    thinkingBudgetTokens: null,
    thinkingDisplaySummarized: true,
    effortLevels: ["high" as const],
    promptCaching: true,
    minCacheablePrefixTokens: 512,
    serverSideCompaction: true,
    contextEditing: true,
    serverSideTools: {
      webSearch: over.webSearch ?? false,
      webFetch: over.webFetch ?? false,
      codeExecution: false,
    },
    liveModelDiscovery: true,
    serverSideRefusalFallback: true,
    midConversationSystemMessages: true,
    midConversationToolChanges: true,
  };
}
