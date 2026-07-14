import type { EventEnvelope } from "@clawdparty/contracts";
import { describe, expect, it, vi } from "vitest";
import { type QueryHandle, RunConflict, Runner, UnknownRun } from "../src/runner.js";
import type { Transport } from "../src/transport.js";

// Capture everything shipped to the transport.
function captureTransport(): {
  transport: Transport;
  durable: EventEnvelope[];
  ephemeral: EventEnvelope[];
} {
  const durable: EventEnvelope[] = [];
  const ephemeral: EventEnvelope[] = [];
  const transport = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    deliverDurable: async (events: EventEnvelope[]) => {
      durable.push(...events);
      return "acked" as const;
    },
    deliverEphemeral: async (event: EventEnvelope) => {
      ephemeral.push(event);
    },
  } as unknown as Transport;
  return { transport, durable, ephemeral };
}

// A controllable fake query: yields scripted messages, resolves a promise when drained.
function scriptedQuery(messages: unknown[]): { handle: QueryHandle; interrupted: () => boolean } {
  let interrupted = false;
  async function* gen(): AsyncGenerator<unknown> {
    for (const m of messages) {
      yield m;
    }
  }
  const it = gen();
  const handle = Object.assign(it, {
    interrupt: () => {
      interrupted = true;
      return Promise.resolve();
    },
  }) as unknown as QueryHandle;
  return { handle, interrupted: () => interrupted };
}

const baseInput = {
  run_id: "r1",
  session_id: "s1",
  repo_path: "/repo",
  prompt: "build it",
  requested_by: "p1",
};

describe("Runner", () => {
  it("drives the query and ships normalized lifecycle events; clears active when done", async () => {
    const { transport, durable } = captureTransport();
    const { handle } = scriptedQuery([
      {
        type: "system",
        subtype: "init",
        model: "m",
        cwd: "/repo",
        permissionMode: "acceptEdits",
        session_id: "sdk-1",
      },
      {
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        num_turns: 1,
        total_cost_usd: 0.5,
        usage: {},
      },
    ]);
    const runner = new Runner(transport, () => handle);

    runner.startRun(baseInput);
    expect(runner.activeRunIds()).toEqual(["r1"]);
    await vi.waitFor(() => expect(durable.some((e) => e.type === "run_finished")).toBe(true));

    const types = durable.map((e) => e.type);
    expect(types).toContain("run_started");
    expect(types).toContain("run_finished");
    expect(runner.activeRunIds()).toEqual([]); // cleared after drain
  });

  it("rejects a second concurrent start with RunConflict", () => {
    const { transport } = captureTransport();
    // A query that never ends, so the run stays active.
    const handle = Object.assign(
      (async function* (): AsyncGenerator<unknown> {
        await new Promise(() => {}); // hang
      })(),
      { interrupt: () => Promise.resolve() },
    ) as unknown as QueryHandle;
    const runner = new Runner(transport, () => handle);

    runner.startRun(baseInput);
    expect(() => runner.startRun({ ...baseInput, run_id: "r2" })).toThrow(RunConflict);
  });

  it("interrupt emits a user-attributed run_interrupted and calls the SDK interrupt", async () => {
    const { transport, durable } = captureTransport();
    let interrupted = false;
    // Yield one init, then hang — so the run stays active until we interrupt it.
    const handle = Object.assign(
      (async function* (): AsyncGenerator<unknown> {
        yield {
          type: "system",
          subtype: "init",
          model: "m",
          cwd: "/repo",
          permissionMode: "acceptEdits",
          session_id: "x",
        };
        await new Promise(() => {}); // hang
      })(),
      {
        interrupt: () => {
          interrupted = true;
          return Promise.resolve();
        },
      },
    ) as unknown as QueryHandle;
    const runner = new Runner(transport, () => handle);
    runner.startRun(baseInput);
    await vi.waitFor(() => expect(durable.some((e) => e.type === "run_started")).toBe(true));

    await runner.interrupt("r1");
    expect(interrupted).toBe(true);
    const ev = durable.find((e) => e.type === "run_interrupted");
    expect(ev?.actor).toEqual({ kind: "user", id: "p1" });
  });

  it("follow-up / interrupt to an unknown run throws UnknownRun", async () => {
    const { transport } = captureTransport();
    const runner = new Runner(transport, () => scriptedQuery([]).handle);
    expect(() => runner.sendMessage("nope", "x")).toThrow(UnknownRun);
    await expect(runner.interrupt("nope")).rejects.toBeInstanceOf(UnknownRun);
  });
});
