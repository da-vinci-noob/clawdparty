import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ReplayPolicy } from "../store/types.js";
import {
  BinaryContent,
  Escape,
  MAX_BYTES,
  Oversized,
  assertNotBinary,
  assertReadable,
  containForCreate,
  isDenylisted,
} from "./paths.js";
import { type ToolContext, type ToolDefinition, type ToolResult, textResult } from "./registry.js";

/**
 * The `text_editor` tool — canonical schema-less declaration
 * `{ type: "text_editor_20250728", name: "str_replace_based_edit_tool" }`.
 *
 * Replay policy is PER SUB-COMMAND: `view` is a pure read and is `safe`;
 * `create` / `str_replace` / `insert` mutate the worktree and are `never`. A
 * single tool-level policy would either re-run a write after a crash or refuse to
 * re-run a harmless read.
 *
 * Every `path` goes through the same realpath-containment + denylist pipeline as
 * Rails' `RepoBrowser`, so a file the API refuses to show is a file this tool
 * refuses to touch.
 */

export const TEXT_EDITOR_TOOL_NAME = "str_replace_based_edit_tool";

export type TextEditorCommand = "view" | "create" | "str_replace" | "insert";

export interface TextEditorInput {
  command: TextEditorCommand;
  path: string;
  file_text?: string;
  old_str?: string;
  new_str?: string;
  insert_line?: number;
  view_range?: [number, number];
}

export const definition: ToolDefinition = {
  name: TEXT_EDITOR_TOOL_NAME,
  replay: "never",
  schema: { type: "text_editor_20250728", name: TEXT_EDITOR_TOOL_NAME },
  replayFor: (input) => replayForCommand((input as TextEditorInput | undefined)?.command),
  run: (input, ctx) => run(input as TextEditorInput, ctx),
};

export function replayForCommand(command: TextEditorCommand | undefined): ReplayPolicy {
  return command === "view" ? "safe" : "never";
}

export async function run(input: TextEditorInput, ctx: ToolContext): Promise<ToolResult> {
  try {
    switch (input.command) {
      case "view":
        return view(input, ctx);
      case "create":
        return create(input, ctx);
      case "str_replace":
        return strReplace(input, ctx);
      case "insert":
        return insert(input, ctx);
      default:
        return textResult(`unknown command: ${String(input.command)}`, true);
    }
  } catch (err) {
    return textResult(refusalMessage(err, input.path), true);
  }
}

function view(input: TextEditorInput, ctx: ToolContext): ToolResult {
  const resolved = assertReadable(ctx.cwd, input.path);
  const bytes = readFileSync(resolved);
  assertNotBinary(bytes);

  const lines = bytes.toString("utf8").split("\n");
  const [from, to] = input.view_range ?? [1, lines.length];
  // 1-indexed and inclusive, matching the tool's documented contract. `to = -1`
  // means "to the end".
  const end = to === -1 ? lines.length : to;
  const selected = lines.slice(Math.max(from - 1, 0), end);

  const numbered = selected.map((line, i) => `${String(from + i).padStart(6)}\t${line}`).join("\n");
  return textResult(numbered);
}

function create(input: TextEditorInput, ctx: ToolContext): ToolResult {
  if (input.file_text === undefined) return textResult("create requires `file_text`", true);
  // Denylist is checked explicitly here: containForCreate cannot run the read
  // pipeline on a file that does not exist yet, so skipping this would let a tool
  // CREATE `.env` even though it can never READ one.
  if (isDenylisted(input.path)) throw new Escape("denylisted");

  const resolved = containForCreate(ctx.cwd, input.path);
  const existed = existsSync(resolved);
  if (Buffer.byteLength(input.file_text, "utf8") > MAX_BYTES) {
    throw new Oversized(`exceeds ${MAX_BYTES} bytes`);
  }

  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, input.file_text, "utf8");
  ctx.onFileChanged?.(input.path, existed ? "modified" : "created");

  return textResult(`${existed ? "Overwrote" : "Created"} ${input.path}`);
}

function strReplace(input: TextEditorInput, ctx: ToolContext): ToolResult {
  if (input.old_str === undefined) return textResult("str_replace requires `old_str`", true);
  const resolved = assertReadable(ctx.cwd, input.path);
  const bytes = readFileSync(resolved);
  assertNotBinary(bytes);
  const content = bytes.toString("utf8");

  const occurrences = countOccurrences(content, input.old_str);
  if (occurrences === 0) return textResult(`\`old_str\` not found in ${input.path}`, true);
  // Refusing an ambiguous match is deliberate: replacing the first of several
  // silently edits the wrong line and the model cannot tell.
  if (occurrences > 1) {
    return textResult(
      `\`old_str\` appears ${occurrences} times in ${input.path}; make it unique`,
      true,
    );
  }

  writeFileSync(resolved, content.replace(input.old_str, input.new_str ?? ""), "utf8");
  ctx.onFileChanged?.(input.path, "modified");
  return textResult(`Edited ${input.path}`);
}

function insert(input: TextEditorInput, ctx: ToolContext): ToolResult {
  if (input.insert_line === undefined) return textResult("insert requires `insert_line`", true);
  if (input.new_str === undefined) return textResult("insert requires `new_str`", true);

  const resolved = assertReadable(ctx.cwd, input.path);
  const bytes = readFileSync(resolved);
  assertNotBinary(bytes);

  const lines = bytes.toString("utf8").split("\n");
  if (input.insert_line < 0 || input.insert_line > lines.length) {
    return textResult(`insert_line ${input.insert_line} out of range (0..${lines.length})`, true);
  }

  // `insert_line` is the line AFTER which to insert; 0 means the top of the file.
  lines.splice(input.insert_line, 0, input.new_str);
  writeFileSync(resolved, lines.join("\n"), "utf8");
  ctx.onFileChanged?.(input.path, "modified");
  return textResult(`Inserted into ${input.path} after line ${input.insert_line}`);
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/**
 * A refusal names the class of problem without confirming what exists outside the
 * worktree — the same posture as `RepoBrowser` mapping every escape to 404.
 */
function refusalMessage(err: unknown, path: string): string {
  if (err instanceof Oversized) return `${path} exceeds the ${MAX_BYTES}-byte limit`;
  if (err instanceof BinaryContent) return `${path} is binary`;
  if (err instanceof Escape) return `${path} is not available`;
  return `${path}: ${String(err)}`;
}
