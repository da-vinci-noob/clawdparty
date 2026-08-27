import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { containExisting, isDenylisted } from "./paths.js";
import { type ToolContext, type ToolDefinition, type ToolResult, textResult } from "./registry.js";

const run_ = promisify(execFile);

/**
 * `grep` — search file contents. `ReplayPolicy: "safe"`.
 *
 * Backed by `git grep`, which searches only tracked/untracked-not-ignored files,
 * so it inherits the same exclusions as `glob` and `RepoBrowser#tree`.
 */

export interface GrepInput {
  pattern: string;
  path?: string;
  ignore_case?: boolean;
  limit?: number;
}

export const DEFAULT_LIMIT = 200;

export const definition: ToolDefinition = {
  name: "grep",
  replay: "safe",
  schema: {
    name: "grep",
    description: "Search file contents in the worktree.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Extended regular expression." },
        path: { type: "string", description: "Restrict to this subtree." },
        ignore_case: { type: "boolean" },
        limit: { type: "integer", description: `Max matching lines (default ${DEFAULT_LIMIT}).` },
      },
      required: ["pattern"],
    },
  },
  run: async (input, ctx) => run(input as GrepInput, ctx),
};

export async function run(input: GrepInput, ctx: ToolContext): Promise<ToolResult> {
  try {
    const root = containExisting(ctx.cwd, ".");
    // A `path` scope is contained before use — otherwise `path: "../.."` would
    // widen the search beyond the worktree even though git runs inside it.
    const scope = input.path ? relativize(root, containExisting(root, input.path)) : undefined;

    const args = [
      "grep",
      "--line-number",
      "--no-color",
      "--extended-regexp",
      "--untracked",
      ...(input.ignore_case ? ["--ignore-case"] : []),
      "-e",
      input.pattern,
    ];
    if (scope) args.push("--", scope);

    const { stdout } = await run_("git", args, {
      cwd: root,
      signal: ctx.signal,
      maxBuffer: 8 * 1024 * 1024,
    });

    const hits = stdout
      .split("\n")
      .filter((line) => line !== "")
      .filter((line) => !isDenylisted(line.split(":")[0] ?? ""));

    const limit = input.limit ?? DEFAULT_LIMIT;
    const shown = hits.slice(0, limit);
    const note = hits.length > limit ? `\n[${hits.length - limit} more not shown]` : "";

    return textResult(shown.length === 0 ? "no matches" : `${shown.join("\n")}${note}`);
  } catch (err) {
    // git grep exits 1 for "no matches", which is not an error condition.
    if ((err as { code?: number }).code === 1) return textResult("no matches");
    return textResult(`grep failed: ${String(err)}`, true);
  }
}

function relativize(root: string, absolute: string): string {
  return absolute === root ? "." : absolute.slice(root.length + 1);
}
