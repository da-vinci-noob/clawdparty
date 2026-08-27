import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { containExisting, isDenylisted } from "./paths.js";
import { type ToolContext, type ToolDefinition, type ToolResult, textResult } from "./registry.js";

const run_ = promisify(execFile);

/**
 * `glob` — find files by pattern. `ReplayPolicy: "safe"`.
 *
 * Backed by `git ls-files --cached --others --exclude-standard`, the same source
 * as `RepoBrowser#tree`. That is not an implementation detail: it means `.git`
 * internals and `.gitignore`'d files (build output, `node_modules`, local secrets)
 * are never listed, which a filesystem walk would happily include.
 */

export interface GlobInput {
  pattern: string;
  limit?: number;
}

export const DEFAULT_LIMIT = 500;

export const definition: ToolDefinition = {
  name: "glob",
  replay: "safe",
  schema: {
    name: "glob",
    description: "Find files in the worktree by glob pattern (tracked + untracked, never ignored).",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob, e.g. 'src/**/*.ts'." },
        limit: { type: "integer", description: `Max results (default ${DEFAULT_LIMIT}).` },
      },
      required: ["pattern"],
    },
  },
  run: async (input, ctx) => run(input as GlobInput, ctx),
};

export async function run(input: GlobInput, ctx: ToolContext): Promise<ToolResult> {
  try {
    const root = containExisting(ctx.cwd, ".");
    const { stdout } = await run_(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "--", input.pattern],
      { cwd: root, signal: ctx.signal, maxBuffer: 8 * 1024 * 1024 },
    );

    const matches = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      // A denylisted path must not even be NAMED: a listing that reveals `.env`
      // exists is a smaller leak than its contents, but it is still a leak.
      .filter((line) => !isDenylisted(line))
      .sort();

    const limit = input.limit ?? DEFAULT_LIMIT;
    const shown = matches.slice(0, limit);
    const note = matches.length > limit ? `\n[${matches.length - limit} more not shown]` : "";

    return textResult(shown.length === 0 ? "no matches" : `${shown.join("\n")}${note}`);
  } catch (err) {
    return textResult(`glob failed: ${String(err)}`, true);
  }
}
