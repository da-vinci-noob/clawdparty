import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@clawdparty/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type QueryHandle, Runner, type StartRunInput } from "../src/runner.js";
import type { Transport } from "../src/transport.js";

function captureTransport(): { transport: Transport; durable: EventEnvelope[] } {
  const durable: EventEnvelope[] = [];
  const transport = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    deliverDurable: async (events: EventEnvelope[]) => {
      durable.push(...events);
      return "acked" as const;
    },
    deliverEphemeral: async () => {},
  } as unknown as Transport;
  return { transport, durable };
}

// Hangs forever so options are captured at startRun time without the run ending.
function hangingHandle(): QueryHandle {
  return Object.assign(
    (async function* (): AsyncGenerator<unknown> {
      await new Promise(() => {});
    })(),
    { interrupt: () => Promise.resolve() },
  ) as unknown as QueryHandle;
}

// Capture the options buildOptions produced for a given run-start input.
function optionsFor(input: StartRunInput): Record<string, unknown> {
  const { transport } = captureTransport();
  const captured: { options?: Record<string, unknown> } = {};
  const runner = new Runner(transport, (params) => {
    captured.options = params.options;
    return hangingHandle();
  });
  runner.startRun(input);
  if (!captured.options) {
    throw new Error("query was not invoked");
  }
  return captured.options;
}

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "clawd-repo-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function writeMcpJson(servers: Record<string, unknown>): void {
  writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
}

const baseInput: StartRunInput = {
  run_id: "r1",
  session_id: "s1",
  repo_path: "/repo",
  prompt: "go",
  requested_by: "p1",
};

describe("buildOptions — capability mapping", () => {
  it("maps disallowed_tools → SDK disallowedTools (bare names)", () => {
    const options = optionsFor({ ...baseInput, disallowed_tools: ["Bash", "WebFetch"] });
    expect(options.disallowedTools).toEqual(["Bash", "WebFetch"]);
  });

  it("resolves a connector into mcpServers and appends mcp__<name>__* to allowedTools", () => {
    writeMcpJson({ github: { command: "gh-mcp", args: ["serve"] } });
    const options = optionsFor({ ...baseInput, repo_path: repo, connectors: ["github"] });
    expect(Object.keys(options.mcpServers as object)).toEqual(["github"]);
    expect(options.allowedTools).toContain("mcp__github__*");
    // The base pre-approval tools are preserved alongside the connector pattern.
    expect(options.allowedTools).toContain("Read");
  });

  it("sets settingSources + skills when skills is a non-empty array", () => {
    const options = optionsFor({ ...baseInput, skills: ["deploy"] });
    expect(options.settingSources).toEqual(["user", "project"]);
    expect(options.skills).toEqual(["deploy"]);
  });

  it('sets settingSources + skills when skills is "all"', () => {
    const options = optionsFor({ ...baseInput, skills: "all" });
    expect(options.settingSources).toEqual(["user", "project"]);
    expect(options.skills).toBe("all");
  });

  it("omitted fields → today's behavior (none of the new options set)", () => {
    const options = optionsFor(baseInput);
    expect(options.disallowedTools).toBeUndefined();
    expect(options.mcpServers).toBeUndefined();
    expect(options.settingSources).toBeUndefined();
    expect(options.skills).toBeUndefined();
    expect(options.allowedTools).toEqual(["Read", "Write", "Edit", "Bash"]);
    expect(options.permissionMode).toBe("acceptEdits");
    expect(options.cwd).toBe("/repo");
  });

  it("leakage: the explicitly-built option set is not expanded by settings files", () => {
    // Only the SELECTED connector is present; buildOptions never copies hooks/
    // permissions/subagents from a settings file onto the explicit options.
    writeMcpJson({ github: { command: "gh" } });
    const options = optionsFor({ ...baseInput, repo_path: repo, connectors: ["github"] });
    expect(Object.keys(options.mcpServers as object)).toEqual(["github"]);
    expect(options.hooks).toBeUndefined();
    expect(options.permissions).toBeUndefined();
  });
});

describe("startRun — run_started stays lean (capabilities are not echoed)", () => {
  it("does not echo disallowed_tools/connectors/skills even when a selection is applied", async () => {
    writeMcpJson({ github: { command: "gh" } });
    const { transport, durable } = captureTransport();
    const handle = Object.assign(
      (async function* (): AsyncGenerator<unknown> {
        yield {
          type: "system",
          subtype: "init",
          model: "m",
          cwd: repo,
          permissionMode: "acceptEdits",
          session_id: "sdk-1",
        };
        yield {
          type: "result",
          subtype: "success",
          stop_reason: "end_turn",
          num_turns: 1,
          usage: {},
        };
      })(),
      { interrupt: () => Promise.resolve() },
    ) as unknown as QueryHandle;
    const runner = new Runner(transport, () => handle);

    runner.startRun({
      ...baseInput,
      repo_path: repo,
      disallowed_tools: ["Bash"],
      connectors: ["github", "unknown"],
      skills: ["deploy"],
    });
    await vi.waitFor(() => expect(durable.some((e) => e.type === "run_started")).toBe(true));

    const payload = durable.find((e) => e.type === "run_started")?.payload as Record<
      string,
      unknown
    >;
    expect(payload).not.toHaveProperty("disallowed_tools");
    expect(payload).not.toHaveProperty("connectors");
    expect(payload).not.toHaveProperty("skills");
  });

  it("omits the capability fields from run_started when nothing was selected", async () => {
    const { transport, durable } = captureTransport();
    const handle = Object.assign(
      (async function* (): AsyncGenerator<unknown> {
        yield {
          type: "system",
          subtype: "init",
          model: "m",
          cwd: "/repo",
          permissionMode: "acceptEdits",
          session_id: "sdk-1",
        };
        yield {
          type: "result",
          subtype: "success",
          stop_reason: "end_turn",
          num_turns: 1,
          usage: {},
        };
      })(),
      { interrupt: () => Promise.resolve() },
    ) as unknown as QueryHandle;
    const runner = new Runner(transport, () => handle);

    runner.startRun(baseInput);
    await vi.waitFor(() => expect(durable.some((e) => e.type === "run_started")).toBe(true));

    const payload = durable.find((e) => e.type === "run_started")?.payload as Record<
      string,
      unknown
    >;
    expect(payload).not.toHaveProperty("disallowed_tools");
    expect(payload).not.toHaveProperty("connectors");
    expect(payload).not.toHaveProperty("skills");
  });
});
