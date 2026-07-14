import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildServer, flushWithTimeout, startHeartbeat } from "../src/index.js";
import { Transport } from "../src/transport.js";

describe("Fastify server (W1 skeleton)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /healthz returns empty active_run_ids (no runner in W1)", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ active_run_ids: [] });
  });

  it("run-control routes exist and return 501 in the skeleton", async () => {
    for (const url of ["/runs", "/runs/run_1/messages", "/runs/run_1/interrupt"]) {
      const res = await app.inject({ method: "POST", url, payload: {} });
      expect(res.statusCode).toBe(501);
    }
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
    const hb = startHeartbeat(config, logger, fetchImpl as unknown as typeof fetch);
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
    const hb = startHeartbeat(config, logger, fetchImpl as unknown as typeof fetch);
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
