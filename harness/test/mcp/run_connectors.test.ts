import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@clawdparty/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpSession } from "../../src/mcp/client.js";
import type {
  Capabilities,
  ProviderAdapter,
  ProviderEvent,
  ProviderRequest,
} from "../../src/providers/contract.js";
import { Supervisor } from "../../src/supervisor.js";
import { Transport } from "../../src/transport.js";

/**
 * A run's connectors reach the model, and DO NOT reach the next run.
 *
 * The isolation is the part that would fail silently. MCP tools belong to the run that enabled
 * them; registering them into the supervisor's shared registry would leak them into every later
 * run on this harness — including runs that enabled nothing — and the only symptom would be a
 * model calling a tool nobody offered it.
 */

const CAPS: Capabilities = {
  streaming: true,
  toolUse: true,
  toolUseWhileStreaming: true,
  contextWindow: 200_000,
  maxOutputTokens: 8192,
  adaptiveThinking: false,
  thinkingDisplaySummarized: false,
  effortLevels: [],
  promptCaching: false,
  minCacheablePrefixTokens: null,
  serverSideCompaction: false,
  contextEditing: false,
  serverSideTools: { webSearch: false, webFetch: false, codeExecution: false },
  liveModelDiscovery: false,
  serverSideRefusalFallback: false,
  midConversationSystemMessages: true,
  midConversationToolChanges: true,
};

/** Records the tool declarations of every request, which is what "the model was offered X" means. */
const offered: string[][] = [];

const adapter: ProviderAdapter = {
  id: "anthropic-direct",
  displayName: "stub",
  entitlement: { credentialKind: "api_key", thirdPartyClientPermitted: "yes", note: "" },
  probe: async () => ({ available: true, credentialSource: "env:ANTHROPIC_API_KEY" }),
  listModels: async () => [],
  capabilities: () => CAPS,
  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    offered.push(req.tools.map((t) => t.name));
    yield { t: "message_start", model: "m" };
    yield { t: "block_start", index: 0, kind: "text" };
    yield { t: "text_delta", index: 0, text: "done" };
    yield { t: "block_stop", index: 0, block: { type: "text", text: "done" } };
    yield {
      t: "message_delta",
      stopReason: "end_turn",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
    yield { t: "message_stop" };
  },
};

const shipped: EventEnvelope[] = [];

/** A real Transport with the POST intercepted, so the events assert what would ship to Rails. */
function capturingTransport(): Transport {
  return new Transport({
    railsInternalUrl: "http://rails:3000",
    sharedSecret: "s",
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String((init as { body?: unknown }).body ?? "{}")) as {
        events?: EventEnvelope[];
      };
      shipped.push(...(body.events ?? []));
      return new Response("{}", { status: 200 });
    },
  });
}

let dir: string;
let cwd: string;
let supervisor: Supervisor;
let closed = 0;

function session(): McpSession {
  return {
    tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }],
    call: async () => ({ text: "found it", isError: false }),
    close: async () => {
      closed += 1;
    },
  };
}

beforeEach(() => {
  offered.length = 0;
  shipped.length = 0;
  closed = 0;
  dir = mkdtempSync(join(tmpdir(), "mcp-run-store-"));
  cwd = mkdtempSync(join(tmpdir(), "mcp-run-cwd-"));
  writeFileSync(
    join(cwd, ".mcp.json"),
    JSON.stringify({ mcpServers: { notes: { command: "notes-server" } } }),
  );
  supervisor = new Supervisor(capturingTransport(), {
    storeDir: dir,
    adapters: { "anthropic-direct": adapter },
    mcpConnect: async () => session(),
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/**
 * Poll rather than await the run's promise: `startRun` resolves when the run has STARTED (the
 * route returns 202 and the loop runs on), and the internal `done` is deliberately not public.
 */
async function waitUntil(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function run(runId: string, connectors?: string[]): Promise<void> {
  await supervisor.startRun({
    run_id: runId,
    session_id: "70",
    prompt: "go",
    requested_by: "1",
    model: "m",
    repo_path: cwd,
    provider: "anthropic-direct",
    ...(connectors ? { connectors } : {}),
  } as never);
  await waitUntil(
    () => shipped.some((e) => e.ai_run_id === runId && TERMINAL.has(String(e.type))),
    `run ${runId} to settle`,
  );
}

const TERMINAL = new Set(["run_finished", "run_failed", "run_interrupted"]);

const startedFor = (runId: string) =>
  shipped.find((e) => e.type === "run_started" && e.ai_run_id === runId)?.payload as
    | Record<string, unknown>
    | undefined;

describe("a run that enables a connector", () => {
  it("offers the model the connector's tools alongside the built-ins", async () => {
    await run("1", ["notes"]);

    expect(offered[0]).toContain("mcp__notes__search");
    expect(offered[0]).toContain("bash");
  });

  it("echoes the connector on run_started", async () => {
    await run("1", ["notes"]);
    expect(startedFor("1")?.connectors).toEqual(["notes"]);
  });

  it("closes the session when the run ends", async () => {
    await run("1", ["notes"]);
    // The close happens in the run's own `finally`, just after it stops being ACTIVE, so this
    // waits on the effect rather than assuming it already landed.
    await waitUntil(() => closed === 1, "the MCP session to close");
    // A leaked stdio server outlives the run that spawned it, and nothing would ever reap it.
    expect(closed).toBe(1);
  });
});

describe("the NEXT run", () => {
  it("does not inherit the previous run's MCP tools", async () => {
    await run("1", ["notes"]);
    await run("2");

    // The leak this test exists for: registering into the shared registry would offer
    // `mcp__notes__search` to a run that enabled nothing, and the only symptom would be the model
    // calling a tool nobody gave it.
    expect(offered[1]).not.toContain("mcp__notes__search");
    expect(offered[1]).toContain("bash");
  });

  it("echoes no connectors when none were enabled", async () => {
    await run("1");
    expect(startedFor("1")).not.toHaveProperty("connectors");
  });
});

describe("a connector that cannot load", () => {
  it("still runs, and records the failure as a CLASSIFICATION", async () => {
    supervisor = new Supervisor(capturingTransport(), {
      storeDir: dir,
      adapters: { "anthropic-direct": adapter },
      mcpConnect: async () => {
        throw new Error("spawn notes-server ENOENT");
      },
    });
    await run("3", ["notes"]);

    // The run completes — a broken server is not a broken run — and the payload names the
    // connector with a KIND, never the transport's own message (which could carry a token).
    expect(startedFor("3")?.connectors_failed).toEqual([{ name: "notes", kind: "failed" }]);
    expect(JSON.stringify(startedFor("3"))).not.toContain("ENOENT");
    expect(shipped.some((e) => e.type === "run_finished" && e.ai_run_id === "3")).toBe(true);
  });

  it("classifies a name the host never configured", async () => {
    await run("4", ["ghost"]);
    expect(startedFor("4")?.connectors_failed).toEqual([{ name: "ghost", kind: "not_configured" }]);
  });
});
