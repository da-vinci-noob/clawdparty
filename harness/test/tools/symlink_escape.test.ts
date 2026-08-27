import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Escape, assertReadable, assertWritable, containForCreate } from "../../src/tools/paths.js";

/**
 * symlinks that leave the project resolve, and writes still cannot.
 *
 * The asymmetry is the whole point of this file, and it is the thing the host move
 * changed. In a container the mount set WAS the boundary: a symlink out mostly failed
 * to resolve at all. On the host it resolves, so the boundary has to be a decision
 * rather than a side effect of the topology, and reads and writes get different answers.
 *
 * READS follow the link.  requires it outright ("100% of symlinks that leave the
 * project directory resolve correctly") and real projects need it: a pnpm workspace
 * links node_modules entries to a store outside the repo, and `npm link` does the same.
 * Refusing them would protect nothing anyway, because model-directed `bash` can already
 * read whatever the developer can.
 *
 * WRITES do not. Approve commits the worktree and reject runs `git reset --hard &&
 * git clean -fd` in it, so a write landing outside is invisible to the diff AND
 * survives a reject — the room would be approving a change set that does not describe
 * what happened.
 */

let worktree: string;
let outside: string;

beforeEach(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "harness-symlink-")));
  worktree = join(base, "session-worktree");
  outside = join(base, "outside-the-worktree");
  mkdirSync(worktree, { recursive: true });
  mkdirSync(outside, { recursive: true });
});

afterEach(() => {
  rmSync(join(worktree, ".."), { recursive: true, force: true });
});

describe("reads follow a symlink out of the worktree", () => {
  it("reads a pnpm-style linked dependency whose target lives outside the repo", () => {
    // node_modules/.pnpm/<pkg> -> a store outside the project. The canonical case.
    const store = join(outside, "pnpm-store", "lodash@4.17.21");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "index.js"), "module.exports = {};\n");

    const nodeModules = join(worktree, "node_modules");
    mkdirSync(nodeModules, { recursive: true });
    symlinkSync(store, join(nodeModules, "lodash"));

    const resolved = assertReadable(worktree, join(nodeModules, "lodash", "index.js"));

    expect(resolved).toBe(realpathSync(join(store, "index.js")));
  });

  it("reads an `npm link`ed sibling package", () => {
    const sibling = join(outside, "my-lib");
    mkdirSync(join(sibling, "src"), { recursive: true });
    writeFileSync(join(sibling, "src", "index.ts"), "export const x = 1;\n");
    symlinkSync(sibling, join(worktree, "linked-lib"));

    expect(() =>
      assertReadable(worktree, join(worktree, "linked-lib", "src", "index.ts")),
    ).not.toThrow();
  });

  it("reads a symlinked FILE, not just a symlinked directory", () => {
    writeFileSync(join(outside, "shared.json"), "{}\n");
    symlinkSync(join(outside, "shared.json"), join(worktree, "shared.json"));

    expect(() => assertReadable(worktree, join(worktree, "shared.json"))).not.toThrow();
  });

  it("still refuses a denylisted file even when it resolves", () => {
    writeFileSync(join(outside, ".env"), "SECRET=1\n");
    symlinkSync(join(outside, ".env"), join(worktree, ".env"));

    // The denylist is what actually protects reads now that containment does not.
    expect(() => assertReadable(worktree, join(worktree, ".env"))).toThrow(Escape);
  });

  it("still refuses a path that resolves to nothing", () => {
    symlinkSync(join(outside, "gone"), join(worktree, "dangling"));

    expect(() => assertReadable(worktree, join(worktree, "dangling"))).toThrow(Escape);
  });
});

describe("writes stay inside the worktree", () => {
  it("refuses to write THROUGH a symlink pointing out of the worktree", () => {
    writeFileSync(join(outside, "target.txt"), "original\n");
    symlinkSync(join(outside, "target.txt"), join(worktree, "innocent.txt"));

    // The file is readable (above) and still NOT writable: reject would revert the
    // worktree and leave this edit behind.
    expect(() => assertWritable(worktree, join(worktree, "innocent.txt"))).toThrow(Escape);
  });

  it("refuses to create a file through a symlinked directory", () => {
    symlinkSync(outside, join(worktree, "escape-dir"));

    expect(() => containForCreate(worktree, join(worktree, "escape-dir", "new.txt"))).toThrow(
      Escape,
    );
  });

  it("refuses a ../ traversal out of the worktree", () => {
    writeFileSync(join(outside, "target.txt"), "x\n");

    expect(() =>
      assertWritable(worktree, join(worktree, "..", "outside-the-worktree", "target.txt")),
    ).toThrow(Escape);
  });

  it("allows a write to a real file inside the worktree", () => {
    const inside = join(worktree, "src", "app.ts");
    mkdirSync(join(worktree, "src"), { recursive: true });
    writeFileSync(inside, "export {};\n");

    // Without this the suite above would pass with a rule that refuses every write.
    expect(assertWritable(worktree, inside)).toBe(realpathSync(inside));
  });

  it("allows a create for a nested path that does not exist yet", () => {
    const target = containForCreate(worktree, join(worktree, "a", "b", "c.ts"));

    expect(target.startsWith(worktree)).toBe(true);
  });

  it("follows a symlink INSIDE the worktree, which is not an escape", () => {
    const real = join(worktree, "real");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "file.ts"), "export {};\n");
    symlinkSync(real, join(worktree, "alias"));

    // Internal links are ordinary repo structure; only leaving the worktree matters.
    expect(() => assertWritable(worktree, join(worktree, "alias", "file.ts"))).not.toThrow();
  });
});
