import { readFileSync } from "node:fs";
import {
  BinaryContent,
  Escape,
  MAX_BYTES,
  Oversized,
  assertNotBinary,
  assertReadable,
} from "./paths.js";
import { type ToolContext, type ToolDefinition, type ToolResult, textResult } from "./registry.js";

/**
 * `read` — a pure read, so `ReplayPolicy: "safe"`. Re-running it after a crash
 * costs nothing and cannot change the worktree.
 *
 * Reuses the same containment + denylist + 1MB cap + null-byte detection pipeline
 * as Rails' `RepoBrowser`. Unlike `bash` and `text_editor`, this tool carries an
 * `input_schema`: it is ours, not a canonical provider tool.
 */

export interface ReadInput {
  path: string;
  offset?: number;
  limit?: number;
}

export const definition: ToolDefinition = {
  name: "read",
  replay: "safe",
  schema: {
    name: "read",
    description: "Read a file from the session worktree.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the worktree root." },
        offset: { type: "integer", description: "1-indexed first line to return." },
        limit: { type: "integer", description: "Maximum number of lines to return." },
      },
      required: ["path"],
    },
  },
  run: async (input, ctx) => run(input as ReadInput, ctx),
};

export function run(input: ReadInput, ctx: ToolContext): ToolResult {
  try {
    const resolved = assertReadable(ctx.cwd, input.path);
    const bytes = readFileSync(resolved);
    assertNotBinary(bytes);

    const lines = bytes.toString("utf8").split("\n");
    const from = Math.max((input.offset ?? 1) - 1, 0);
    const slice = lines.slice(from, input.limit ? from + input.limit : undefined);

    return textResult(
      slice.map((line, i) => `${String(from + i + 1).padStart(6)}\t${line}`).join("\n"),
    );
  } catch (err) {
    if (err instanceof Oversized)
      return textResult(`${input.path} exceeds ${MAX_BYTES} bytes`, true);
    if (err instanceof BinaryContent) return textResult(`${input.path} is binary`, true);
    if (err instanceof Escape) return textResult(`${input.path} is not available`, true);
    return textResult(`${input.path}: ${String(err)}`, true);
  }
}
