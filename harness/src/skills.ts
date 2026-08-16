import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { Escape, containExisting } from "./tools/paths.js";
import { type ToolDefinition, type ToolResult, textResult } from "./tools/registry.js";

/**
 * Skills, made real for a run.
 *
 * `skills` was accepted by the harness, validated by Rails, forwarded, and dropped — the composer
 * sent `skills: "all"` on every run and nothing read it, so the popover's live count described a
 * capability no run had. The SDK's `settingSources` mechanism went with the SDK; composing them is
 * the harness's job now.
 *
 * PROGRESSIVE DISCLOSURE, not inlining, for a measured reason: this host has 79 skills, and every
 * SKILL.md in the system prompt would be tens of thousands of tokens per turn, nearly all of it
 * irrelevant to the prompt at hand. So the system prompt carries a one-line INDEX and the model
 * loads a body through the `skill` tool when it decides one applies — which is how skills are meant
 * to be used, and it keeps the cost proportional to what is actually needed.
 *
 * The tool takes a NAME, never a path, and looks it up in a map built by our own scan. That is a
 * stronger guarantee than validating a path after the fact: there is no arithmetic to escape. The
 * body read is still realpath-contained to the skill's own root, because a symlinked `SKILL.md` is
 * otherwise a reader for anything the harness user can open.
 */

const SKILL_FILE = "SKILL.md";

/** Long enough for a real skill, short enough that one cannot flood the conversation. */
export const MAX_SKILL_BODY_BYTES = 64 * 1024;

export interface ResolvedSkills {
  /** Skill names actually available to the run — what `run_started` echoes. */
  names: string[];
  /** System-prompt section, or "" when there is nothing to add. */
  index: string;
  /** The `skill` tool, or null when no skills resolved (nothing to load). */
  tool: ToolDefinition | null;
}

interface Located {
  name: string;
  description: string;
  /** The skills ROOT this came from, kept so the body read is contained to it. */
  root: string;
  /** The directory name inside that root, which may differ from the frontmatter name. */
  dir: string;
}

/**
 * Resolve a run's skill selection.
 *
 * `"all"` means every discovered skill; an array means those names; an empty array means none.
 * A selected name the host does not have is DROPPED rather than indexed — the model must never be
 * told about a skill it cannot load.
 */
export function resolveSkills(
  cwd: string,
  selection: "all" | readonly string[],
  home: string = homedir(),
): ResolvedSkills {
  const wanted = selection === "all" ? null : new Set(selection);
  if (wanted?.size === 0) {
    return { names: [], index: "", tool: null };
  }

  const located = locateSkills(cwd, home).filter((skill) => wanted?.has(skill.name) ?? true);
  if (located.length === 0) {
    return { names: [], index: "", tool: null };
  }

  const byName = new Map(located.map((skill) => [skill.name, skill]));
  return {
    names: [...byName.keys()],
    index: indexFor(located),
    tool: skillTool(byName),
  };
}

/** The skills roots, project first — a repo's copy of a name wins over the host-wide one. */
function locateSkills(cwd: string, home: string): Located[] {
  const roots = [join(cwd, ".claude", "skills"), join(home, ".claude", "skills")];
  const byName = new Map<string, Located>();
  for (const root of roots) {
    for (const skill of scan(root)) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()];
}

function scan(root: string): Located[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: Located[] = [];
  for (const dir of entries) {
    let content: string;
    try {
      if (!statSync(join(root, dir)).isDirectory()) continue;
      content = readFileSync(join(root, dir, SKILL_FILE), "utf8");
    } catch {
      continue;
    }
    const frontmatter = parseFrontmatter(content);
    out.push({
      name: frontmatter.name && frontmatter.name.length > 0 ? frontmatter.name : dir,
      description: frontmatter.description ?? "",
      root,
      dir,
    });
  }
  return out;
}

/**
 * How much of a description the index carries.
 *
 * Measured: with block scalars parsed correctly (46 of 58 skills use one), the untruncated index
 * runs to tens of KB — real cost on EVERY turn, for text whose job is only to say "this one might
 * apply". The trigger is in the opening sentence; the body is one `skill` call away.
 */
const MAX_INDEX_DESCRIPTION = 200;

function indexFor(skills: readonly Located[]): string {
  const lines = skills
    .map((skill) => `- ${skill.name}${skill.description ? `: ${clip(skill.description)}` : ""}`)
    .sort();
  return [
    "## Available skills",
    "",
    // Without this sentence the index is trivia: the model has no reason to think a name is
    // loadable, and the bodies are the part that changes what it does.
    "Load a skill's full instructions with the `skill` tool before acting on it.",
    "",
    ...lines,
  ].join("\n");
}

export function skillTool(byName: ReadonlyMap<string, Located>): ToolDefinition {
  const names = [...byName.keys()];
  return {
    name: "skill",
    // A pure read: re-running it after a crash costs nothing and changes nothing.
    replay: "safe",
    schema: {
      name: "skill",
      description: "Load the full instructions for one of the available skills.",
      input_schema: {
        type: "object",
        properties: {
          // Enumerated, so the model is choosing among what exists rather than guessing a name.
          name: { type: "string", description: "The skill to load.", enum: names },
        },
        required: ["name"],
      },
    },
    run: async (input): Promise<ToolResult> => {
      const requested = (input as { name?: unknown }).name;
      const skill = typeof requested === "string" ? byName.get(requested) : undefined;
      if (!skill) {
        return textResult(`No such skill. Available: ${names.join(", ")}`, true);
      }
      return readBody(skill);
    },
  };
}

function readBody(skill: Located): ToolResult {
  let body: string;
  try {
    // Contained to the skill's OWN root: the name came from our scan, but the file it points at
    // can still be a symlink out of the tree.
    const path = containExisting(skill.root, join(skill.dir, SKILL_FILE));
    body = readFileSync(path, "utf8");
  } catch (err) {
    const why = err instanceof Escape ? "escapes the skills directory" : "could not be read";
    return textResult(`Skill ${skill.name} ${why}.`, true);
  }

  if (body.length <= MAX_SKILL_BODY_BYTES) {
    return textResult(body);
  }
  return textResult(
    `${body.slice(0, MAX_SKILL_BODY_BYTES)}\n\n[truncated at ${MAX_SKILL_BODY_BYTES} bytes]`,
  );
}

/**
 * The system prompt a run actually sends.
 *
 * A PURE function of the base prompt and the resolved index, and exported for that reason:
 * `scripts/reconstruct.ts` verifies a recorded `system_prompt_digest` against a supplied prompt, so
 * a run whose prompt was composed must be recomposable from the record (`run_started` echoes the
 * cwd and the resolved skill names). Otherwise every skill-enabled run reconstructs as a digest
 * mismatch.
 */
export function composeSystemPrompt(base: string, index: string): string {
  return index === "" ? base : `${base}\n\n${index}`;
}

function clip(description: string): string {
  return description.length <= MAX_INDEX_DESCRIPTION
    ? description
    : `${description.slice(0, MAX_INDEX_DESCRIPTION).trimEnd()}…`;
}
