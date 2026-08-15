import type { Capabilities, ToolSchema } from "../providers/contract.js";
import type { ReplayPolicy } from "../store/types.js";

/**
 * Tool registration, carrying a `ReplayPolicy` per tool.
 *
 * The policy is what recovery consults after a crash: a `never` tool gets a
 * synthetic interrupted result instead of being re-run , so the
 * conversation stays coherent — every call has an outcome — and nothing executes
 * twice.
 *
 * ANYTHING UNDECLARED IS `never`. Failing safe matters more than convenience
 * here: a tool wrongly marked `safe` re-runs a side effect after a crash, and the
 * wrong answer is silent. `register()` therefore takes `replay` as a required
 * field, and `policyFor()` returns `never` for an unknown name.
 */

export interface ToolContext {
  /** The session worktree. Every path a tool touches is contained within it. */
  cwd: string;
  runId: string;
  signal: AbortSignal;
  /** Emitted as `terminal_output` chunks (~64KB each) while a tool runs. */
  onOutput?: (chunk: string) => void;
  /** Emitted as `file_changed` when a tool mutates the worktree. */
  onFileChanged?: (path: string, change: "created" | "modified") => void;
}

export interface ToolResult {
  /** Content blocks for the `tool_result`, provider-neutral. */
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

export interface ToolDefinition {
  name: string;
  replay: ReplayPolicy;
  /**
   * The declaration sent to the provider. Canonical server tools are
   * SCHEMA-LESS — `{ type: "bash_20250124", name: "bash" }` with no
   * `input_schema`. Adding one changes the tool's identity as far as the provider
   * is concerned.
   */
  schema: ToolSchema;
  /**
   * Gate on a capability so a provider that cannot serve the tool never receives
   * its declaration (R4). Absent means "every provider".
   */
  requires?: (caps: Capabilities) => boolean;
  /**
   * Per-sub-command policy override. `text_editor` is the case that needs it:
   * `view` is a pure read while `create`/`str_replace`/`insert` mutate.
   */
  replayFor?: (input: unknown) => ReplayPolicy;
  run(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * The replay policy for a call. An UNKNOWN tool is `never` — a plugin-provided
   * tool the registry has not seen must not be assumed replayable.
   */
  policyFor(name: string, input?: unknown): ReplayPolicy {
    const tool = this.tools.get(name);
    if (!tool) return "never";
    if (tool.replayFor && input !== undefined) return tool.replayFor(input);
    return tool.replay;
  }

  /**
   * Declarations to send, filtered by what this provider/model can serve and by
   * the run's own disallow list.
   *
   * `disallowed` genuinely REMOVES a tool rather than merely un-approving it —
   * the distinction matters because an allow-list only pre-approves, so a tool
   * left declared can still be called.
   */
  schemasFor(caps: Capabilities, disallowed: readonly string[] = []): ToolSchema[] {
    const denied = new Set(disallowed);
    return [...this.tools.values()]
      .filter((tool) => !denied.has(tool.name))
      .filter((tool) => tool.requires?.(caps) ?? true)
      .map((tool) => tool.schema);
  }
}

/** Convenience for a tool returning plain text. */
export function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError };
}
