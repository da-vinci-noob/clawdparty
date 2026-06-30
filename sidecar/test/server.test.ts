import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildServer, flushWithTimeout, startHeartbeat } from "../src/index.js";
import { type QueryHandle, Runner } from "../src/runner.js";
import { Transport } from "../src/transport.js";

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

// A fake SDK query: yields a result message then ends; interrupt is a no-op.
function fakeQueryHandle(): QueryHandle {
  async function* gen(): AsyncGenerator<unknown> {
    yield { type: "result", subtype: "success", stop_reason: "end_turn", num_turns: 1, usage: {} };
  }
  const it = gen();
  return Object.assign(it, { interrupt: () => Promise.resolve() }) as unknown as QueryHandle;
}

function buildTestServer(): { app: FastifyInstance; runner: Runner } {
  const transport = new Transport({
    railsInternalUrl: "http://rails:3000",
    sharedSecret: "s",
    logger: noopLogger,
    fetchImpl: vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 })) as unknown as typeof fetch,
  });
  const runner = new Runner(transport, () => fakeQueryHandle());
  return { app: buildServer(runner), runner };
}

describe("Fastify server (runner-backed)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildTestServer().app;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /healthz returns active_run_ids", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("active_run_ids");
  });

  it("POST /runs returns 202 with the frozen success shape", async () => {
    const { app: a } = buildTestServer();
    await a.ready();
    const res = await a.inject({
      method: "POST",
      url: "/runs",
      payload: {
        run_id: "r1",
        session_id: "s1",
        repo_path: "/repo",
        prompt: "hi",
        requested_by: "p1",
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ run_id: "r1", status: "running" });
    await a.close();
  });

  it("POST /runs/:id/messages and /interrupt to an unknown run are 404", async () => {
    const { app: a } = buildTestServer();
    await a.ready();
    const m = await a.inject({
      method: "POST",
      url: "/runs/nope/messages",
      payload: { message: "x" },
    });
    expect(m.statusCode).toBe(404);
    const i = await a.inject({ method: "POST", url: "/runs/nope/interrupt", payload: {} });
    expect(i.statusCode).toBe(404);
    await a.close();
  });
});

describe("config — no hard-coded Rails host; RAILS_INTERNAL_URL distinct from SIDECAR_URL", () => {
  it("reads RAILS_INTERNAL_URL from env and defaults sensibly", () => {
    expect(loadConfig({}).railsInternalUrl).toBe("http://rails:3000");
    expect(loadConfig({ RAILS_INTERNAL_URL: "http://other:3000" }).railsInternalUrl).toBe(
      "http://other:3000",
    );
  });
});

describe("heartbeat", () => {
  it("treats a 401 as fatal and stops beating", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    } as unknown as FastifyInstance["log"];
    const config = loadConfig({ HEARTBEAT_INTERVAL_MS: "10000" });
    const hb = startHeartbeat(config, logger, () => [], fetchImpl as unknown as typeof fetch);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    hb.stop();
    expect(logger.error).toHaveBeenCalled();
  });

  it("does not crash when Rails is unreachable (transient)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("down"));
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    } as unknown as FastifyInstance["log"];
    const config = loadConfig({ HEARTBEAT_INTERVAL_MS: "10000" });
    const hb = startHeartbeat(config, logger, () => [], fetchImpl as unknown as typeof fetch);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    hb.stop();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("SIGTERM flush is bounded", () => {
  it("returns within the timeout even if the flush hangs", async () => {
    const hanging = vi.fn().mockReturnValue(new Promise<Response>(() => {})); // never resolves
    const transport = new Transport({
      railsInternalUrl: "http://rails:3000",
      sharedSecret: "s",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      fetchImpl: hanging as unknown as typeof fetch,
    });
    // Buffer one event so flush attempts a (hanging) POST.
    void transport.deliverDurable([
      {
        id: null,
        session_id: "s",
        ai_run_id: "r",
        seq: 1,
        type: "ai_text",
        actor: { kind: "claude" },
        ts: "2026-06-28T20:11:05.123Z",
        payload: {},
      },
    ]);
    const start = Date.now();
    await flushWithTimeout(transport, 50);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
