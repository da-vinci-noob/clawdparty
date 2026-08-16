import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSkills } from "../src/capabilities.js";
import { parseFrontmatter } from "../src/frontmatter.js";
import { resolveSkills } from "../src/skills.js";
import { addSkill, removeSkill } from "../src/skills_admin.js";

/**
 * Adding and removing host skills, which is the app's FIRST write outside a session worktree.
 *
 * Two things make this different from ordinary CRUD and shape every rule below:
 *
 *  1. **A skill is instructions Claude will follow.** Adding one is closer to granting a capability
 *     than to editing a document, so a write must land exactly where it was asked to land and
 *     nowhere else — no path arithmetic, no traversal, no symlink escape.
 *  2. **A removal destroys someone's work.** The repo's precedent is `bin/harness reset-session`,
 *     which MOVES a store aside rather than deleting it, because destroying a record on request is
 *     how you lose one that mattered. So remove renames; nothing here calls unlink.
 */

let home: string;
let cwd: string;

const projectSkills = () => join(cwd, ".claude", "skills");
const hostSkills = () => join(home, ".claude", "skills");
const removedRoot = () => join(cwd, ".claude", "skills-removed");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "admin-home-"));
  cwd = mkdtempSync(join(tmpdir(), "admin-cwd-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("adding a skill", () => {
  it("writes SKILL.md with frontmatter into the PROJECT root", () => {
    const result = addSkill({
      cwd,
      home,
      scope: "project",
      name: "deploy",
      description: "Ship to staging",
      body: "# Deploy\n\nRun bin/deploy.",
    });

    expect(result.ok).toBe(true);
    const written = readFileSync(join(projectSkills(), "deploy", "SKILL.md"), "utf8");
    // Asserted through the REAL parser rather than as raw text: what matters is that a file we
    // write is a file we can read back, and the description is written as a block scalar (the shape
    // 46 of 58 skills on this host use, and the one that makes an injected newline harmless).
    expect(parseFrontmatter(written)).toEqual({
      name: "deploy",
      description: "Ship to staging",
    });
    expect(written).toContain("Run bin/deploy.");
  });

  it("writes into the HOST root when asked, and says which it used", () => {
    // The two roots mean two different blast radii, so the caller chooses explicitly and the
    // result names the choice back — an implied destination is how a host-wide skill gets added by
    // someone who meant to add a project one.
    const result = addSkill({ cwd, home, scope: "host", name: "pdf", description: "d", body: "b" });

    expect(result.ok && result.scope).toBe("host");
    expect(existsSync(join(hostSkills(), "pdf", "SKILL.md"))).toBe(true);
    expect(existsSync(join(projectSkills(), "pdf"))).toBe(false);
  });

  it("creates the skills directory when the host has none yet", () => {
    expect(
      addSkill({ cwd, home, scope: "project", name: "first", description: "d", body: "b" }).ok,
    ).toBe(true);
  });

  it("refuses to overwrite an existing skill unless told to replace it", () => {
    addSkill({ cwd, home, scope: "project", name: "deploy", description: "one", body: "first" });
    const second = addSkill({
      cwd,
      home,
      scope: "project",
      name: "deploy",
      description: "two",
      body: "second",
    });

    // Silently replacing instructions Claude follows is the destructive surprise this avoids.
    expect(second).toMatchObject({ ok: false, reason: "exists" });
    expect(readFileSync(join(projectSkills(), "deploy", "SKILL.md"), "utf8")).toContain("first");
  });

  it("replaces when replace: true is passed", () => {
    addSkill({ cwd, home, scope: "project", name: "deploy", description: "one", body: "first" });
    const second = addSkill({
      cwd,
      home,
      scope: "project",
      name: "deploy",
      description: "two",
      body: "second",
      replace: true,
    });

    expect(second.ok).toBe(true);
    expect(readFileSync(join(projectSkills(), "deploy", "SKILL.md"), "utf8")).toContain("second");
  });

  it("escapes a description that would break the frontmatter", () => {
    // A description is free text from a browser field; a newline in it would silently produce
    // frontmatter whose remaining keys are prose.
    const result = addSkill({
      cwd,
      home,
      scope: "project",
      name: "tricky",
      description: "line one\n---\nname: hijacked",
      body: "b",
    });

    expect(result.ok).toBe(true);
    const parsed = parseFrontmatter(
      readFileSync(join(projectSkills(), "tricky", "SKILL.md"), "utf8"),
    );
    // The name survives, and the injected `name: hijacked` stays inside the description where it
    // is inert text rather than a frontmatter key.
    expect(parsed.name).toBe("tricky");
    expect(parsed.description).toContain("hijacked");
  });
});

describe("names that are not names", () => {
  const rejected = [
    "../escape",
    "..",
    ".",
    "/absolute",
    "nested/name",
    ".hidden",
    "",
    "   ",
    "has space",
    "UPPER",
    "trailing-",
    "a".repeat(80),
  ];

  for (const name of rejected) {
    it(`refuses ${JSON.stringify(name)}`, () => {
      const result = addSkill({ cwd, home, scope: "project", name, description: "d", body: "b" });

      // The name becomes a DIRECTORY we create. Validating it as a strict single segment is what
      // makes the write incapable of landing outside the skills root, rather than relying on a
      // check afterwards.
      expect(result).toMatchObject({ ok: false, reason: "invalid_name" });
    });
  }

  it("accepts an ordinary kebab-case name", () => {
    expect(
      addSkill({ cwd, home, scope: "project", name: "pdf-forms-2", description: "d", body: "b" })
        .ok,
    ).toBe(true);
  });

  it("writes nothing at all when the name is refused", () => {
    addSkill({ cwd, home, scope: "project", name: "../escape", description: "d", body: "b" });

    expect(existsSync(join(cwd, ".claude"))).toBe(false);
    expect(existsSync(join(home, "escape"))).toBe(false);
  });
});

describe("removing a skill", () => {
  function seed(scope: "project" | "host", name: string, body = "original"): void {
    addSkill({ cwd, home, scope, name, description: "d", body });
  }

  it("MOVES it aside rather than deleting it", () => {
    seed("project", "deploy");
    const result = removeSkill({ cwd, home, scope: "project", name: "deploy" });

    expect(result.ok).toBe(true);
    // Recoverable on disk: destroying a record on request is how you lose one that mattered.
    expect(existsSync(join(projectSkills(), "deploy"))).toBe(false);
    expect(readFileSync(join(removedRoot(), "deploy", "SKILL.md"), "utf8")).toContain("original");
  });

  it("moves it OUT of the skills root, so nothing discovers it any more", () => {
    // Found live, and it made removal a no-op: renaming in place to `deploy.removed` left the
    // directory inside `skills/`, and discovery keys on the frontmatter `name` — so the skill stayed
    // listed, stayed in the run's index, and stayed loadable by the `skill` tool.
    //
    // A filter in the scanner would work until the next scanner forgets it (the frontmatter parser
    // was duplicated exactly that way). Moving it out makes the invariant STRUCTURAL: if it is not
    // in `skills/`, nothing can load it.
    seed("project", "deploy");
    removeSkill({ cwd, home, scope: "project", name: "deploy" });

    expect(resolveSkills(cwd, "all", home).names).not.toContain("deploy");
    expect(listSkills(cwd, home).skills.map((s) => s.name)).not.toContain("deploy");
  });

  it("keeps earlier removals instead of clobbering them", () => {
    seed("project", "deploy", "first");
    removeSkill({ cwd, home, scope: "project", name: "deploy" });
    seed("project", "deploy", "second");
    const again = removeSkill({ cwd, home, scope: "project", name: "deploy" });

    expect(again.ok).toBe(true);
    expect(readFileSync(join(removedRoot(), "deploy", "SKILL.md"), "utf8")).toContain("first");
    expect(readFileSync(join(removedRoot(), "deploy-2", "SKILL.md"), "utf8")).toContain("second");
  });

  it("reports a name that is not there, rather than pretending to remove it", () => {
    expect(removeSkill({ cwd, home, scope: "project", name: "ghost" })).toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });

  it("only removes from the scope it was asked about", () => {
    seed("host", "shared");
    const result = removeSkill({ cwd, home, scope: "project", name: "shared" });

    // A project removal must never reach into the host root: the same name can exist in both, and
    // the project copy is the one the participant was looking at.
    expect(result).toMatchObject({ ok: false, reason: "not_found" });
    expect(existsSync(join(hostSkills(), "shared"))).toBe(true);
  });

  it("refuses an invalid name without touching the filesystem", () => {
    seed("project", "deploy");
    const result = removeSkill({ cwd, home, scope: "project", name: "../.." });

    expect(result).toMatchObject({ ok: false, reason: "invalid_name" });
    expect(existsSync(join(projectSkills(), "deploy"))).toBe(true);
  });

  it("does not follow a symlinked skill directory out of the root", () => {
    const outside = mkdtempSync(join(tmpdir(), "admin-outside-"));
    writeFileSync(join(outside, "SKILL.md"), "SOMEONE ELSE'S FILE");
    mkdirSync(projectSkills(), { recursive: true });
    // A symlinked skill dir would otherwise let a "remove" rename a directory anywhere on disk.
    require("node:fs").symlinkSync(outside, join(projectSkills(), "linked"));

    const result = removeSkill({ cwd, home, scope: "project", name: "linked" });

    expect(result.ok).toBe(false);
    expect(existsSync(join(outside, "SKILL.md"))).toBe(true);
    rmSync(outside, { recursive: true, force: true });
  });
});
