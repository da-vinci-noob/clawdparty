import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpConnect, McpSession } from "../../src/mcp/client.js";
import { attachConnectors, mcpToolName } from "../../src/mcp/connectors.js";
import type { ToolContext } from "../../src/tools/registry.js";

/**
 * The selection/naming/failure layer of MCP support, without a subprocess.
 *
 * `connectors` was accepted, validated, forwarded and DROPPED, while the popover showed the
 * host's real server count — so the room advertised tools no run had. Making it real means the
 * parts that can silently misbehave are: which server a name resolves to, what the tool is called,
 * and what happens when a server is broken or slow. All three are covered here with an injected
 * connect, because a test that needs 8 live MCP servers is a test nobody runs.
 */

const ctx = (): ToolContext => ({
  cwd: "/tmp",
  runId: "1",
  signal: new AbortController().signal,
});

function fakeSession(over: Partial<McpSession> = {}): McpSession {
  return {
    tools: [
      { name: "search", description: "Search notes", inputSchema: { type: "object" } },
      { name: "write", inputSchema: { type: "object", properties: { body: { type: "string" } } } },
    ],
    call: async () => ({ text: "ok", isError: false }),
    close: async () => {},
    ...over,
  };
}

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mcp-home-"));
  cwd = mkdtempSync(join(tmpdir(), "mcp-cwd-"));
  // The host's own config is the ONLY source of a server definition.
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        notes: { command: "notes-server", args: ["--stdio"] },
        remote: { url: "https://example.test/mcp", type: "http" },
      },
    }),
  );
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("no connectors selected", () => {
  it("does nothing at all — no config read, no connection", async () => {
    let called = false;
    const attachment = await attachConnectors({
      cwd,
      names: [],
      home,
      connect: async () => {
        called = true;
        return fakeSession();
      },
    });

    expect(attachment.tools).toEqual([]);
    expect(attachment.loaded).toEqual([]);
    expect(called).toBe(false);
  });
});

describe("a selected, host-configured server", () => {
  const connect: McpConnect = async () => fakeSession();

  it("registers its tools under mcp__<server>__<tool>", async () => {
    const attachment = await attachConnectors({ cwd, names: ["notes"], home, connect });

    // The convention is load-bearing twice: it cannot collide with a built-in (`read`, `bash`),
    // and it makes ONE MCP tool nameable in `disallowed_tools`.
    expect(attachment.tools.map((t) => t.name)).toEqual([
      "mcp__notes__search",
      "mcp__notes__write",
    ]);
    expect(attachment.loaded).toEqual(["notes"]);
  });

  it("carries the server's own schema and description through", async () => {
    const attachment = await attachConnectors({ cwd, names: ["notes"], home, connect });
    const [search, write] = attachment.tools;

    expect(search?.schema).toMatchObject({
      name: "mcp__notes__search",
      description: "Search notes",
      input_schema: { type: "object" },
    });
    // No description offered → the field is absent, not an empty string the model has to read.
    expect(write?.schema).not.toHaveProperty("description");
  });

  it("marks every MCP tool as NEVER replayable", async () => {
    const attachment = await attachConnectors({ cwd, names: ["notes"], home, connect });

    // Nothing in `tools/list` says whether a call has side effects, so re-running one after a
    // crash could repeat it. Failing safe is the registry's own default for unknown tools.
    expect(attachment.tools.every((t) => t.replay === "never")).toBe(true);
  });

  it("passes the call through and returns the server's text", async () => {
    const attachment = await attachConnectors({
      cwd,
      names: ["notes"],
      home,
      connect: async () =>
        fakeSession({
          call: async (tool, input) => ({
            text: `${tool}:${JSON.stringify(input)}`,
            isError: false,
          }),
        }),
    });

    const result = await attachment.tools[0]?.run({ q: "hi" }, ctx());
    // The BARE tool name goes to the server — the `mcp__` prefix is our addressing, not its.
    expect(result?.content[0]?.text).toBe('search:{"q":"hi"}');
    expect(result?.isError).toBe(false);
  });

  it("turns a server error into a failed TOOL, not a failed run", async () => {
    const attachment = await attachConnectors({
      cwd,
      names: ["notes"],
      home,
      connect: async () =>
        fakeSession({
          call: async () => {
            throw new Error("upstream exploded");
          },
        }),
    });

    const result = await attachment.tools[0]?.run({}, ctx());
    // The model sees the error as a tool_result and can react — the same shape as a bash
    // non-zero exit. Throwing here would take the whole run down over one bad call.
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain("upstream exploded");
  });

  it("reports an isError result from the server as an error", async () => {
    const attachment = await attachConnectors({
      cwd,
      names: ["notes"],
      home,
      connect: async () => fakeSession({ call: async () => ({ text: "nope", isError: true }) }),
    });

    expect((await attachment.tools[0]?.run({}, ctx()))?.isError).toBe(true);
  });
});

describe("a server that cannot be used", () => {
  it("is REPORTED, and the other servers still load", async () => {
    const attachment = await attachConnectors({
      cwd,
      names: ["notes", "remote"],
      home,
      connect: async (server) => {
        if (server === "remote") throw new Error("connection refused");
        return fakeSession();
      },
    });

    expect(attachment.loaded).toEqual(["notes"]);
    expect(attachment.failed).toEqual([{ server: "remote", reason: "connection refused" }]);
    expect(attachment.tools).toHaveLength(2);
  });

  it("does not hang the run when a server never answers", async () => {
    const attachment = await attachConnectors({
      cwd,
      names: ["notes"],
      home,
      timeoutMs: 20,
      connect: () => new Promise<McpSession>(() => {}),
    });

    // This runs BEFORE the first request, so an unbounded connect would leave the room showing
    // "working" with nothing arriving — the exact failure the connect timeout removes.
    expect(attachment.loaded).toEqual([]);
    expect(attachment.failed[0]?.reason).toMatch(/did not respond/);
  });

  it("names a selection the host does not configure, rather than silently skipping it", async () => {
    const attachment = await attachConnectors({
      cwd,
      names: ["ghost"],
      home,
      connect: async () => fakeSession(),
    });

    // `resolveConnectors` skips an unknown name defensively; swallowing that is how "I enabled it
    // and nothing happened" becomes unexplainable.
    expect(attachment.failed).toEqual([{ server: "ghost", reason: "not configured on this host" }]);
  });
});

describe("shutting down", () => {
  it("closes every session, even when one throws", async () => {
    const closed: string[] = [];
    const attachment = await attachConnectors({
      cwd,
      names: ["notes", "remote"],
      home,
      connect: async (server) =>
        fakeSession({
          close: async () => {
            closed.push(server);
            if (server === "notes") throw new Error("close failed");
          },
        }),
    });

    await attachment.close();
    // A leaked stdio server outlives the run that spawned it.
    expect(closed.sort()).toEqual(["notes", "remote"]);
  });
});

describe("project config wins over user config", () => {
  it("uses the repo's .mcp.json definition for a name in both", async () => {
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { notes: { command: "repo-notes-server" } } }),
    );
    let sawCommand: string | undefined;
    await attachConnectors({
      cwd,
      names: ["notes"],
      home,
      connect: async (_server, config) => {
        sawCommand = config.command;
        return fakeSession();
      },
    });

    expect(sawCommand).toBe("repo-notes-server");
  });
});

describe("mcpToolName", () => {
  it("is the only place the convention is spelled out", () => {
    expect(mcpToolName("chrom-devtools", "take_snapshot")).toBe(
      "mcp__chrom-devtools__take_snapshot",
    );
  });
});
