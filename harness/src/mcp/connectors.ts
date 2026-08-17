import { resolveConnectors } from "../capabilities.js";
import type { ToolDefinition, ToolResult } from "../tools/registry.js";
import { type McpConnect, type McpSession, connectMcpServer } from "./client.js";

/**
 * Selected connector names → tools a run can actually call.
 *
 * This is the layer that made `connectors` real: the field was accepted, validated by Rails,
 * forwarded, and dropped, while the UI showed the host's live server count — so the room
 * advertised capabilities no run had.
 *
 * Everything here is deliberately ignorant of MCP itself (`client.ts` owns that) so the parts most
 * likely to be wrong are testable without a subprocess: the naming, the failure isolation, and
 * what a tool result looks like when a server errors.
 */

/** `mcp__<server>__<tool>`, Claude Code's convention. */
const NAME_PREFIX = "mcp__";

/**
 * How long a server gets to connect AND list its tools.
 *
 * Bounded because this happens BEFORE the first request: an unbounded connect on a server whose
 * command hangs (a missing binary that waits on stdin, an unreachable URL) would hold the whole
 * run at "working" with nothing to show, which is the failure mode this timeout exists to prevent.
 */
export const CONNECT_TIMEOUT_MS = 10_000;

export interface McpAttachment {
  /** Registrable tools, named `mcp__<server>__<tool>`. */
  tools: ToolDefinition[];
  /** Servers whose tools loaded — what the run should ECHO, since it is what it really has. */
  loaded: string[];
  /** Servers that did not load, with the reason. Never thrown: a broken server is not a broken run. */
  failed: Array<{ server: string; reason: string }>;
  close(): Promise<void>;
}

export interface AttachOptions {
  cwd: string;
  names: readonly string[];
  home?: string;
  connect?: McpConnect;
  timeoutMs?: number;
}

export function mcpToolName(server: string, tool: string): string {
  return `${NAME_PREFIX}${server}__${tool}`;
}

export async function attachConnectors(options: AttachOptions): Promise<McpAttachment> {
  const { cwd, names } = options;
  if (names.length === 0) {
    return { tools: [], loaded: [], failed: [], close: async () => {} };
  }

  // Names only, resolved against host config — a client can enable what the host configured and
  // can never define a server. `resolveConnectors` silently skips an unknown name; that is
  // reported here rather than swallowed, so "I enabled it and nothing happened" cannot occur.
  const { mcpServers } = resolveConnectors(cwd, [...names], options.home);
  const connect = options.connect ?? connectMcpServer;
  const timeoutMs = options.timeoutMs ?? CONNECT_TIMEOUT_MS;

  const tools: ToolDefinition[] = [];
  const loaded: string[] = [];
  const failed: Array<{ server: string; reason: string }> = [];
  const sessions: McpSession[] = [];

  const attempts = names.map(async (server) => {
    const config = mcpServers[server];
    if (config === undefined) {
      return { server, error: "not configured on this host" };
    }
    try {
      const session = await withTimeout(
        connect(server, config as Record<string, unknown>),
        timeoutMs,
        `${server} did not respond within ${timeoutMs}ms`,
      );
      return { server, session };
    } catch (err) {
      return { server, error: err instanceof Error ? err.message : String(err) };
    }
  });

  for (const result of await Promise.all(attempts)) {
    if ("error" in result && result.error !== undefined) {
      failed.push({ server: result.server, reason: result.error });
      continue;
    }
    const session = result.session as McpSession;
    sessions.push(session);
    loaded.push(result.server);
    for (const tool of session.tools) {
      tools.push(definitionFor(result.server, tool.name, tool, session));
    }
  }

  return {
    tools,
    loaded,
    failed,
    async close(): Promise<void> {
      // Every session gets closed even if one throws — a leaked subprocess outlives the run.
      await Promise.all(sessions.map((session) => session.close().catch(() => undefined)));
    },
  };
}

function definitionFor(
  server: string,
  tool: string,
  spec: { description?: string; inputSchema: Record<string, unknown> },
  session: McpSession,
): ToolDefinition {
  return {
    name: mcpToolName(server, tool),
    // Named in a duplicate-id refusal, so "which server" is answerable without reading config.
    origin: `mcp:${server}`,
    // NEVER replayable. The registry's own default for an unknown tool is `never` for exactly
    // this reason: nothing here says whether the call had a side effect, so a crash must not
    // re-run it.
    replay: "never",
    schema: {
      name: mcpToolName(server, tool),
      ...(spec.description ? { description: spec.description } : {}),
      input_schema: spec.inputSchema,
    },
    async run(input, ctx): Promise<ToolResult> {
      try {
        const result = await session.call(tool, input, ctx.signal);
        return { content: [{ type: "text", text: result.text }], isError: result.isError };
      } catch (err) {
        // A failed MCP call is a failed TOOL, not a failed run: the model sees the error as a
        // tool_result and can react, exactly as it does for a bash non-zero exit.
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    },
  };
}

async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
