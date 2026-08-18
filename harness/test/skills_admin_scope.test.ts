import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addSkill, removeSkill, skillsRoot } from "../src/skills_admin.js";
import type { SkillScope } from "../src/skills_admin.js";

/**
 * An unknown `scope` must be REFUSED, not resolved to the more privileged tree.
 *
 * `skillsRoot` was `scope === "project" ? project : HOST`, so anything that was not exactly
 * `"project"` — a typo, a new caller, a future third value — wrote to `~/.claude/skills`. Rails
 * defaults the same field the OPPOSITE way (`params[:scope] == 'host' ? 'host' : 'project'`), so the
 * two ends of one seam failed in opposite directions: safe through Rails, host-wide through anything
 * else.
 *
 * "Anything else" is a real caller set. Every harness route is bearer-authed precisely because
 * loopback is not the boundary — any process running as the developer can reach it with the secret —
 * and this is the one module that writes outside a session worktree. A skill is instructions Claude
 * will follow, so landing one host-wide instead of project-scoped grants a capability to every
 * session on the machine rather than to the one that asked.
 *
 * The module's own rule for names is the precedent: validate so the bad shape is impossible, rather
 * than default and hope.
 */

let cwd: string;
let home: string;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "harness-skill-scope-"));
  cwd = join(base, "project");
  home = join(base, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
});
afterEach(() => {
  rmSync(join(cwd, ".."), { recursive: true, force: true });
});

const bad = (scope: string) => scope as unknown as SkillScope;

describe("an unrecognised scope is refused", () => {
  it("does not write to the HOST tree on a typo", () => {
    const result = addSkill({
      cwd,
      home,
      scope: bad("porject"),
      name: "demo",
      description: "d",
      body: "b",
    });

    expect(result).toMatchObject({ ok: false, reason: "invalid_scope" });
    // The point of the test: nothing landed in the developer's home skills directory.
    expect(existsSync(join(home, ".claude", "skills", "demo"))).toBe(false);
    expect(existsSync(join(cwd, ".claude", "skills", "demo"))).toBe(false);
  });

  it("names the scope it was given, so the caller can see what it sent", () => {
    const result = addSkill({
      cwd,
      home,
      scope: bad("Host"),
      name: "demo",
      description: "d",
      body: "b",
    });

    // `Host` is the plausible mistake — a caller that capitalised it would otherwise get a
    // host-wide write while believing it asked for one thing and typed another.
    expect(result).toMatchObject({ ok: false, reason: "invalid_scope" });
    expect(JSON.stringify(result)).toContain("Host");
  });

  it("refuses a REMOVAL under an unknown scope rather than looking in the host tree", () => {
    expect(removeSkill({ cwd, home, scope: bad(""), name: "demo" })).toMatchObject({
      ok: false,
      reason: "invalid_scope",
    });
  });

  it("still resolves the two real scopes", () => {
    expect(skillsRoot("project", cwd, home)).toBe(join(cwd, ".claude", "skills"));
    expect(skillsRoot("host", cwd, home)).toBe(join(home, ".claude", "skills"));
  });

  it("still writes a project skill where it belongs", () => {
    const result = addSkill({
      cwd,
      home,
      scope: "project",
      name: "demo",
      description: "d",
      body: "b",
    });

    expect(result).toMatchObject({ ok: true, scope: "project" });
    expect(existsSync(join(cwd, ".claude", "skills", "demo", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".claude", "skills", "demo"))).toBe(false);
  });
});
