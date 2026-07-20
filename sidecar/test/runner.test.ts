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

  it("ships run_failed and frees the slot when the query throws mid-drain", async () => {
    // If the SDK query errors (auth/crash/connection) WITHOUT emitting a result,
    // the runner must still emit run_failed so Rails finalizes the run — otherwise
    // it stays active forever and every next message 409s ("a run is already
    // active") with no error surfaced.
    const { transport, durable } = captureTransport();
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
        throw new Error("sdk exploded");
      })(),
      { interrupt: () => Promise.resolve() },
    ) as unknown as QueryHandle;
    const runner = new Runner(transport, () => handle);

    runner.startRun(baseInput);
    await vi.waitFor(() => expect(durable.some((e) => e.type === "run_failed")).toBe(true));
    await vi.waitFor(() => expect(runner.activeRunIds()).toEqual([]));
    // A fresh run can start once the failed run freed the slot.
    expect(() => runner.startRun({ ...baseInput, run_id: "r2" })).not.toThrow();
  });

  it("clears the active slot after run_finished even when the input stream stays open", async () => {
    // Mimics the REAL SDK in streaming-input mode: it yields init + result and
    // then keeps the generator open awaiting more input (the pushable input
    // iterable is never closed). The slot must free on run_finished, NOT wait for
    // the generator to return — otherwise the single run slot leaks forever and
    // every subsequent run 409s.
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
          total_cost_usd: 0.5,
          usage: {},
        };
        await new Promise(() => {}); // stay open like streaming-input mode
      })(),
      { interrupt: () => Promise.resolve() },
    ) as unknown as QueryHandle;
    const runner = new Runner(transport, () => handle);

    runner.startRun(baseInput);
    await vi.waitFor(() => expect(durable.some((e) => e.type === "run_finished")).toBe(true));
    await vi.waitFor(() => expect(runner.activeRunIds()).toEqual([]));

    // And a fresh run can start once the slot is freed.
    expect(() => runner.startRun({ ...baseInput, run_id: "r2" })).not.toThrow();
  });

  it("emits a user_prompt at seq 1, before run_started (seq 2), on a fresh run", async () => {
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

    runner.startRun({ ...baseInput, prompt: "build it" });
    await vi.waitFor(() => expect(durable.some((e) => e.type === "run_finished")).toBe(true));

    const prompt = durable.find((e) => e.type === "user_prompt");
    const started = durable.find((e) => e.type === "run_started");
    expect(prompt).toBeDefined();
    expect(prompt?.payload).toEqual({ text: "build it" });
    expect(prompt?.seq).toBe(1);
    expect(prompt?.ai_run_id).toBe("r1");
    expect(prompt?.actor).toEqual({ kind: "user", id: "p1" });
    expect(started?.seq).toBe(2);
    // Durable, not ephemeral: it carries a non-null seq.
    expect(prompt?.seq).not.toBeNull();
  });

  it("emits exactly one user_prompt per follow-up, before the message is pushed", async () => {
    const { transport, durable } = captureTransport();
    // A query that stays open so the run is active for the follow-up.
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
        await new Promise(() => {}); // stay open
      })(),
      { interrupt: () => Promise.resolve() },
    ) as unknown as QueryHandle;
    const runner = new Runner(transport, () => handle);
    runner.startRun(baseInput);
    await vi.waitFor(() => expect(durable.some((e) => e.type === "run_started")).toBe(true));

    const before = durable.filter((e) => e.type === "user_prompt").length;
    runner.sendMessage("r1", "and now this");
    await vi.waitFor(() =>
      expect(durable.filter((e) => e.type === "user_prompt").length).toBe(before + 1),
    );

    const followUp = durable.filter((e) => e.type === "user_prompt").at(-1);
    expect(followUp?.payload).toEqual({ text: "and now this" });
    expect(followUp?.actor).toEqual({ kind: "user", id: "p1" });
    expect(followUp?.seq).not.toBeNull();
  });

  // A fresh never-ending query per call, so multiple runs can stay active at once.
  const hangingQuery = (): QueryHandle =>
    Object.assign(
      (async function* (): AsyncGenerator<unknown> {
        await new Promise(() => {}); // hang
      })(),
      { interrupt: () => Promise.resolve() },
    ) as unknown as QueryHandle;

  it("rejects a second concurrent start in the SAME session with RunConflict", () => {
    const { transport } = captureTransport();
    const runner = new Runner(transport, () => hangingQuery());

    runner.startRun({ ...baseInput, run_id: "r1", session_id: "sessA" });
    expect(() => runner.startRun({ ...baseInput, run_id: "r2", session_id: "sessA" })).toThrow(
      RunConflict,
    );
  });

  it("allows concurrent runs in DIFFERENT sessions (one active run is PER SESSION)", () => {
    // Regression: the runner had a single global slot, so a run in session A blocked
    // the FIRST run of session B — the sidecar 409'd → Rails "A run is already active
    // for this session". Different sessions must run concurrently.
    const { transport } = captureTransport();
    const runner = new Runner(transport, () => hangingQuery());

    runner.startRun({ ...baseInput, run_id: "r1", session_id: "sessA" });
    expect(() =>
      runner.startRun({ ...baseInput, run_id: "r2", session_id: "sessB" }),
    ).not.toThrow();
    expect(runner.activeRunIds().sort()).toEqual(["r1", "r2"]);
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

  it("passes the selected permission_mode to the SDK query options", () => {
    const { transport } = captureTransport();
    const captured: { options?: Record<string, unknown> } = {};
    const handle = Object.assign(
      (async function* (): AsyncGenerator<unknown> {
        await new Promise(() => {}); // stay open
      })(),
      { interrupt: () => Promise.resolve() },
    ) as unknown as QueryHandle;
    const runner = new Runner(transport, (params) => {
      captured.options = params.options;
      return handle;
    });
    runner.startRun({ ...baseInput, permission_mode: "plan" });
    expect(captured.options?.permissionMode).toBe("plan");
  });

  it("setPermissionMode switches the active run via the query handle", async () => {
    const { transport, durable } = captureTransport();
    const setMode = vi.fn().mockResolvedValue(undefined);
    const handle = Object.assign(
      (async function* (): AsyncGenerator<unknown> {
        yield {
          type: "system",
          subtype: "init",
          model: "m",
          cwd: "/repo",
          permissionMode: "plan",
          session_id: "x",
        };
        await new Promise(() => {}); // stay open (plan run awaits execution)
      })(),
      { interrupt: () => Promise.resolve(), setPermissionMode: setMode },
    ) as unknown as QueryHandle;
    const runner = new Runner(transport, () => handle);
    runner.startRun(baseInput);
    await vi.waitFor(() => expect(durable.some((e) => e.type === "run_started")).toBe(true));

    await runner.setPermissionMode("r1", "acceptEdits");
    expect(setMode).toHaveBeenCalledWith("acceptEdits");
  });

  it("setPermissionMode on an unknown/ended run throws UnknownRun", async () => {
    const { transport } = captureTransport();
    const runner = new Runner(transport, () => scriptedQuery([]).handle);
    await expect(runner.setPermissionMode("nope", "acceptEdits")).rejects.toBeInstanceOf(
      UnknownRun,
    );
  });
});
