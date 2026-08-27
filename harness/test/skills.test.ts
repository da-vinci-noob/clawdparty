import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_SKILL_BODY_BYTES, resolveSkills } from "../src/skills.js";
import type { ToolContext } from "../src/tools/registry.js";

/**
 * The selected skills reach the model.
 *
 * `skills` was accepted, validated by Rails, forwarded, and dropped: the composer sent
 * `skills: "all"` on every run and nothing read it, so the popover's count described a capability
 * runs did not have.
 *
 * The shape is PROGRESSIVE DISCLOSURE, not inlining, and the reason is measurable: this host has
 * 79 skills, and pasting every SKILL.md into the system prompt would be tens of thousands of
 * tokens on every turn, most of them irrelevant. So the prompt carries a one-line INDEX and the
 * model loads a body with the `skill` tool when it decides one applies — which is how skills are
 * designed to work.
 */

const ctx = (cwd: string): ToolContext => ({
  cwd,
  runId: "1",
  signal: new AbortController().signal,
});

let home: string;
let cwd: string;

function writeSkill(root: string, dir: string, frontmatter: string, body: string): void {
  mkdirSync(join(root, ".claude", "skills", dir), { recursive: true });
  writeFileSync(join(root, ".claude", "skills", dir, "SKILL.md"), `${frontmatter}\n${body}`);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "skills-home-"));
  cwd = mkdtempSync(join(tmpdir(), "skills-cwd-"));
  writeSkill(
    home,
    "pdf-forms",
    "---\nname: pdf-forms\ndescription: Fill in PDF forms\n---",
    "# PDF forms\n\nUse pdftk.",
  );
  writeSkill(
    cwd,
    "deploy",
    "---\nname: deploy\ndescription: Ship to staging\n---",
    "# Deploy\n\nRun bin/deploy.",
  );
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe('skills: "all"', () => {
  it("indexes every discovered skill, with its description", () => {
    const resolved = resolveSkills(cwd, "all", home);

    expect(resolved.names.sort()).toEqual(["deploy", "pdf-forms"]);
    expect(resolved.index).toContain("deploy: Ship to staging");
    expect(resolved.index).toContain("pdf-forms: Fill in PDF forms");
  });

  it("indexes only, never the bodies — that is the whole point", () => {
    // 79 skills on this host. Inlining them is tens of thousands of tokens per turn, nearly all
    // of it unrelated to the prompt.
    const resolved = resolveSkills(cwd, "all", home);

    expect(resolved.index).not.toContain("Run bin/deploy");
    expect(resolved.index).not.toContain("Use pdftk");
  });

  it("tells the model how to load one, or the index is just trivia", () => {
    expect(resolveSkills(cwd, "all", home).index).toMatch(/`skill` tool/);
  });
});

describe("an explicit selection", () => {
  it("indexes only the named skills", () => {
    const resolved = resolveSkills(cwd, ["deploy"], home);

    expect(resolved.names).toEqual(["deploy"]);
    expect(resolved.index).toContain("deploy");
    expect(resolved.index).not.toContain("pdf-forms");
  });

  it("drops a name the host does not have, rather than inventing an entry", () => {
    const resolved = resolveSkills(cwd, ["deploy", "ghost"], home);
    expect(resolved.names).toEqual(["deploy"]);
  });
});

describe("no skills", () => {
  it("adds nothing at all for an empty selection", () => {
    const resolved = resolveSkills(cwd, [], home);

    expect(resolved.names).toEqual([]);
    expect(resolved.index).toBe("");
    expect(resolved.tool).toBeNull();
  });

  it("adds nothing when the host has none, even for 'all'", () => {
    const empty = mkdtempSync(join(tmpdir(), "skills-none-"));
    const resolved = resolveSkills(empty, "all", empty);

    expect(resolved.index).toBe("");
    expect(resolved.tool).toBeNull();
    rmSync(empty, { recursive: true, force: true });
  });
});

describe("the skill tool", () => {
  it("returns the body of a resolved skill", async () => {
    const tool = resolveSkills(cwd, "all", home).tool;
    const result = await tool?.run({ name: "deploy" }, ctx(cwd));

    expect(result?.isError).toBe(false);
    expect(result?.content[0]?.text).toContain("Run bin/deploy");
  });

  it("reads a skill from the HOME root too, which is outside the worktree", async () => {
    // `read` is realpath-contained to the worktree, so the model cannot reach `~/.claude/skills`
    // itself. This tool is the only way in, which is also why it takes a NAME and not a path.
    const tool = resolveSkills(cwd, "all", home).tool;
    const result = await tool?.run({ name: "pdf-forms" }, ctx(cwd));

    expect(result?.content[0]?.text).toContain("Use pdftk");
  });

  it("refuses a name that was not resolved, and says which are available", async () => {
    const tool = resolveSkills(cwd, ["deploy"], home).tool;
    const result = await tool?.run({ name: "pdf-forms" }, ctx(cwd));

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain("deploy");
  });

  it("cannot be talked into reading an arbitrary path", async () => {
    // The tool takes a name and looks it up in a map BUILT BY OUR OWN SCAN — there is no path
    // arithmetic to escape, which is a stronger guarantee than validating a path afterwards.
    const tool = resolveSkills(cwd, "all", home).tool;
    for (const name of ["../../../etc/passwd", "/etc/passwd", "deploy/../../..", ""]) {
      const result = await tool?.run({ name }, ctx(cwd));
      expect(result?.isError, `${name} should be refused`).toBe(true);
    }
  });

  it("does not follow a symlink out of the skills root", async () => {
    const secret = join(home, "secret.md");
    writeFileSync(secret, "SHOULD NOT BE READABLE");
    mkdirSync(join(cwd, ".claude", "skills", "sneaky"), { recursive: true });
    symlinkSync(secret, join(cwd, ".claude", "skills", "sneaky", "SKILL.md"));

    const resolved = resolveSkills(cwd, "all", home);
    const result = await resolved.tool?.run({ name: "sneaky" }, ctx(cwd));

    // A symlinked SKILL.md is how a skills dir could be turned into a reader for anything the
    // harness user can open.
    expect(result?.content[0]?.text ?? "").not.toContain("SHOULD NOT BE READABLE");
    expect(result?.isError).toBe(true);
  });

  it("truncates an enormous body rather than flooding the conversation", async () => {
    writeSkill(cwd, "huge", "---\nname: huge\ndescription: big\n---", "x".repeat(200_000));
    const tool = resolveSkills(cwd, "all", home).tool;
    const result = await tool?.run({ name: "huge" }, ctx(cwd));
    const text = result?.content[0]?.text ?? "";

    expect(text.length).toBeLessThan(MAX_SKILL_BODY_BYTES + 200);
    expect(text).toContain("truncated");
  });

  it("is a pure read, so it is safe to replay after a crash", () => {
    expect(resolveSkills(cwd, "all", home).tool?.replay).toBe("safe");
  });

  it("names the loadable skills in its schema, so the model knows what to ask for", () => {
    const schema = resolveSkills(cwd, "all", home).tool?.schema as {
      input_schema?: { properties?: { name?: { enum?: string[] } } };
    };
    expect(schema?.input_schema?.properties?.name?.enum?.sort()).toEqual(["deploy", "pdf-forms"]);
  });
});

describe("the project root wins over home", () => {
  it("prefers the repo's copy of a same-named skill", async () => {
    writeSkill(home, "deploy", "---\nname: deploy\ndescription: home copy\n---", "HOME BODY");
    const resolved = resolveSkills(cwd, "all", home);

    expect(resolved.index).toContain("Ship to staging");
    const result = await resolved.tool?.run({ name: "deploy" }, ctx(cwd));
    expect(result?.content[0]?.text).toContain("Run bin/deploy");
  });
});
