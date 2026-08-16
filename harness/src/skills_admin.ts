import { existsSync, mkdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Adding and removing host skills — the app's FIRST write outside a session worktree.
 *
 * Separate from `skills.ts` (which reads and composes them for a run) because the risks are
 * different, and two of them shape every rule here:
 *
 *  1. **A skill is instructions Claude will follow.** Adding one is closer to granting a capability
 *     than to editing a document. So the write must land exactly where it was asked to land: the
 *     name is validated as a strict single segment BEFORE anything touches the filesystem, which
 *     makes traversal impossible rather than merely checked-for.
 *  2. **A removal destroys someone's work.** So removal MOVES the directory to a sibling
 *     `skills-removed/`, and nothing here unlinks. The precedent is `bin/harness reset-session`,
 *     which moves a store aside rather than deleting it, because destroying a record on request is
 *     how you lose one that mattered.
 *
 * Rails owner-gates the calls (`manage_session`); this module assumes the caller was authorized and
 * concerns itself only with landing the write in the right place.
 */

const SKILL_FILE = "SKILL.md";

/**
 * A skill name is a DIRECTORY name we create, so it is validated as one: lowercase kebab-case, no
 * separators, no dots, no leading/trailing hyphen. Strict on purpose — `..`, `a/b` and `.hidden` are
 * the shapes that turn a write into a write somewhere else, and a permissive name buys nothing.
 */
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * Where a removed skill goes: a sibling of `skills/`, NOT a renamed directory inside it.
 *
 * Renaming in place (`deploy` → `deploy.removed`) looked recoverable and was a no-op: discovery keys
 * on the frontmatter `name`, so the skill stayed listed, stayed in every run's index, and stayed
 * loadable — found by reading a live run's `run_started` echo after a removal. A filter in the
 * scanner would have worked until the next scanner forgot it (the frontmatter parser was duplicated
 * exactly that way), so the invariant is structural instead: if it is not under `skills/`, nothing
 * can load it.
 */
const REMOVED_DIR = "skills-removed";

/** How many `<name>-N` suffixes to try before giving up. */
const MAX_REMOVED_SUFFIX = 50;

export type SkillScope = "project" | "host";

export interface AddSkillInput {
  cwd: string;
  home?: string;
  scope: SkillScope;
  name: string;
  description: string;
  body: string;
  /** Replacing an existing skill must be asked for; silently overwriting is destructive. */
  replace?: boolean;
}

export interface RemoveSkillInput {
  cwd: string;
  home?: string;
  scope: SkillScope;
  name: string;
}

export type SkillWriteResult =
  | { ok: true; scope: SkillScope; name: string; path: string }
  | { ok: false; reason: "invalid_name" | "exists" | "not_found" | "failed"; detail?: string };

/** The two roots, and nothing else is writable. */
export function skillsRoot(scope: SkillScope, cwd: string, home: string = homedir()): string {
  return scope === "project" ? join(cwd, ".claude", "skills") : join(home, ".claude", "skills");
}

export function addSkill(input: AddSkillInput): SkillWriteResult {
  if (!NAME.test(input.name)) {
    return { ok: false, reason: "invalid_name" };
  }
  const root = skillsRoot(input.scope, input.cwd, input.home);
  const dir = join(root, input.name);

  if (existsSync(dir) && input.replace !== true) {
    return { ok: false, reason: "exists" };
  }

  try {
    mkdirSync(dir, { recursive: true });
    // Containment checked AFTER creating, because a not-yet-existing path has no realpath: an
    // existing symlinked ancestor is the case this catches, and the directory we just made is
    // harmless if we refuse now.
    assertInside(root, dir);
    writeFileSync(join(dir, SKILL_FILE), skillFile(input.name, input.description, input.body));
  } catch (err) {
    return {
      ok: false,
      reason: "failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  return { ok: true, scope: input.scope, name: input.name, path: dir };
}

export function removeSkill(input: RemoveSkillInput): SkillWriteResult {
  if (!NAME.test(input.name)) {
    return { ok: false, reason: "invalid_name" };
  }
  const root = skillsRoot(input.scope, input.cwd, input.home);
  const dir = join(root, input.name);

  if (!existsSync(dir)) {
    // Scope-exact: the same name can exist in both roots, and the one the participant was looking
    // at is the one they asked about. Reaching into the other root would remove a different skill.
    return { ok: false, reason: "not_found" };
  }

  try {
    // A SYMLINKED skill directory would otherwise let a "remove" rename a directory anywhere on
    // disk, which is the sharpest edge in this module.
    assertInside(root, dir);
    if (!statSync(dir).isDirectory()) {
      return { ok: false, reason: "not_found" };
    }
    const graveyard = join(root, "..", REMOVED_DIR);
    mkdirSync(graveyard, { recursive: true });
    const target = freeRemovedPath(join(graveyard, input.name));
    if (target === null) {
      return { ok: false, reason: "failed", detail: "too many removed copies" };
    }
    renameSync(dir, target);
    return { ok: true, scope: input.scope, name: input.name, path: target };
  } catch (err) {
    return {
      ok: false,
      reason: "failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** `<name>`, then `<name>-2`, `-3`… so an earlier removal is never clobbered by a later one. */
function freeRemovedPath(base: string): string | null {
  if (!existsSync(base)) {
    return base;
  }
  for (let n = 2; n <= MAX_REMOVED_SUFFIX; n += 1) {
    if (!existsSync(`${base}-${n}`)) return `${base}-${n}`;
  }
  return null;
}

/** Realpath containment: `..` collapses and symlinks resolve, so the check is on the real path. */
function assertInside(root: string, path: string): void {
  const realRoot = realpathSync(existsSync(root) ? root : dirname(root));
  const real = realpathSync(path);
  if (real !== realRoot && !real.startsWith(`${realRoot}/`)) {
    throw new Error("escapes the skills directory");
  }
}

/**
 * The file we write.
 *
 * The description is FREE TEXT from a browser field, so it is written as a block scalar with every
 * line indented: a raw newline in a `key: value` line would silently turn the rest of the
 * frontmatter into prose, and a line reading `---` would end the block early — which is how a
 * description could rewrite the skill's own `name`.
 */
function skillFile(name: string, description: string, body: string): string {
  const indented = description
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
  return `---\nname: ${name}\ndescription: |\n${indented}\n---\n\n${body.trimEnd()}\n`;
}
