/**
 * Explicit JSON schemas for the harness's CANONICAL tools, for providers that do not know
 * them built-in.
 *
 * `bash` and the editor are declared the Anthropic way — a versioned `type` and NO
 * `input_schema` (`bash.ts`, `text_editor.ts`) — because Anthropic models carry the shape
 * server-side. A Converse model (OpenAI, Nova, Llama, …) does not, and Converse rejects a
 * `toolSpec` whose `inputSchema.json.type` is not `"object"`. So the shape has to be spelled
 * out, and it lives HERE, next to the executors it must match: the model emits `toolUse.input`
 * against this schema, and `BashTool`/`TextEditorTool` read those exact fields. A schema that
 * drifted from the executor would have the model fill fields nothing reads.
 *
 * Keyed by tool NAME rather than the versioned `type`, because the name is what the registry
 * dispatches on and is stable across Anthropic tool-version bumps.
 */

/** Matches `BashInput` in `bash.ts`. */
const BASH_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", description: "The bash command to run." },
    restart: { type: "boolean", description: "Restart the bash session before running." },
  },
} as const;

/** Matches `TextEditorInput` in `text_editor.ts`. `command` and `path` are always required;
 *  the rest are per-command and validated by the executor. */
const TEXT_EDITOR_SCHEMA = {
  type: "object",
  properties: {
    command: {
      type: "string",
      enum: ["view", "create", "str_replace", "insert"],
      description: "The edit operation to perform.",
    },
    path: { type: "string", description: "Path relative to the worktree root." },
    file_text: { type: "string", description: "Full contents for `create`." },
    old_str: { type: "string", description: "Text to replace for `str_replace`." },
    new_str: { type: "string", description: "Replacement text for `str_replace`/`insert`." },
    insert_line: { type: "integer", description: "1-indexed line for `insert`." },
    view_range: {
      type: "array",
      items: { type: "integer" },
      description: "Two-element [start, end] line range for `view`.",
    },
  },
  required: ["command", "path"],
} as const;

/** The explicit schema for a canonical tool by name, or null when the harness has no client
 *  executor for it (Anthropic server tools like `web_search`/`web_fetch`, which a Converse
 *  model cannot run and which are withheld from it anyway). */
export function converseSchemaFor(name: string): Record<string, unknown> | null {
  switch (name) {
    case "bash":
      return BASH_SCHEMA as unknown as Record<string, unknown>;
    case "str_replace_based_edit_tool":
      return TEXT_EDITOR_SCHEMA as unknown as Record<string, unknown>;
    default:
      return null;
  }
}
