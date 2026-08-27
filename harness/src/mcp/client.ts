/**
 * The ONLY file that imports the MCP SDK.
 *
 * Same rule the provider adapters follow for their vendor SDKs (`registry.test.ts` asserts the
 * confinement): one importer means one place where a connection is made, one place where a
 * transport is chosen, and one place to look when a server misbehaves. The import is DYNAMIC so a
 * run that names no connectors never loads it.
 *
 * What this module knows: how to talk MCP. What it deliberately does NOT know: which servers a
 * run selected, how tools are named for the model, or what happens when one fails — that is
 * `connectors.ts`, which is testable without a subprocess.
 */

export interface McpToolSpec {
  name: string;
  description?: string;
  /** JSON Schema, verbatim from the server's `tools/list`. */
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

export interface McpSession {
  tools: McpToolSpec[];
  call(tool: string, input: unknown, signal?: AbortSignal): Promise<McpCallResult>;
  close(): Promise<void>;
}

/** A server's host-side config, as it appears in `.mcp.json` / `~/.claude.json`. */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
  headers?: Record<string, string>;
}

/** Injected in tests so the whole selection/naming/failure path runs without a live server. */
export type McpConnect = (
  server: string,
  config: McpServerConfig,
  signal?: AbortSignal,
) => Promise<McpSession>;

// No `signal` parameter: the SDK's `connect()` takes none, and pretending to accept one would
// promise cancellation this cannot deliver. The CALLER bounds it with a timeout race
// (`connectors.ts`), which is the honest shape — `McpConnect` allows the argument so an injected
// fake can use it, and this implementation simply does not.
export async function connectMcpServer(
  server: string,
  config: McpServerConfig,
): Promise<McpSession> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const client = new Client({ name: "clawdparty-harness", version: "1.0.0" });
  await client.connect(await transportFor(server, config));

  const listed = await client.listTools();
  const tools: McpToolSpec[] = listed.tools.map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    // A server may omit the schema; an empty object schema is the honest stand-in, and the
    // Converse translator forces `type: "object"` on it anyway.
    inputSchema: (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>,
  }));

  return {
    tools,
    async call(tool, input, callSignal): Promise<McpCallResult> {
      const result = await client.callTool(
        { name: tool, arguments: (input ?? {}) as Record<string, unknown> },
        undefined,
        callSignal ? { signal: callSignal } : undefined,
      );
      return { text: textOf(result.content), isError: result.isError === true };
    },
    async close(): Promise<void> {
      await client.close();
    },
  };
}

async function transportFor(server: string, config: McpServerConfig): Promise<never> {
  if (typeof config.command === "string") {
    const { StdioClientTransport, getDefaultEnvironment } = await import(
      "@modelcontextprotocol/sdk/client/stdio.js"
    );
    // The server's own `env` wins over the inherited default. `getDefaultEnvironment()` is the
    // SDK's deliberately narrow allow-list rather than all of `process.env`, which keeps the
    // harness's own credentials (ANTHROPIC_API_KEY, AWS_*) out of a subprocess that has no
    // business seeing them.
    return new StdioClientTransport({
      command: config.command,
      ...(config.args ? { args: config.args } : {}),
      env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
    }) as never;
  }

  if (typeof config.url === "string") {
    const url = new URL(config.url);
    const requestInit = config.headers ? { requestInit: { headers: config.headers } } : {};
    if (config.type === "sse") {
      const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
      return new SSEClientTransport(url, requestInit) as never;
    }
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    return new StreamableHTTPClientTransport(url, requestInit) as never;
  }

  // Named, not guessed. A config shape we do not understand is a server the host configured for
  // something else; reporting it is what lets the run say which connector it could not load.
  throw new Error(`connector ${server} has no command or url`);
}

/** MCP content blocks → one text result. Non-text parts are DESCRIBED, never dropped silently. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      const block = (part ?? {}) as { type?: string; text?: string };
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      // The model cannot see an image or a resource through this seam, and pretending the call
      // returned nothing would read as an empty success.
      return `[${block.type ?? "unknown"} content omitted]`;
    })
    .join("\n");
}
