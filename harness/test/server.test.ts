import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@clawdparty/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildServer, flushWithTimeout, startHeartbeat } from "../src/index.js";
import { RunLoop } from "../src/loop/run_loop.js";
import { Supervisor } from "../src/supervisor.js";
import { Transport } from "../src/transport.js";

/**
 * The HTTP surface after the engine swap. Covers the endpoint changes B1-B4 of the
 * declared migration window, including the two that are ABSENCES — a removed route
 * and a removed request field — because a removal nothing asserts quietly comes back.
 */

const CONFIG = {
  port: 8787,
  bindHost: "127.0.0.1",
  railsInternalUrl: "http://rails:3000",
  sharedSecret: "s3cret",
  heartbeatIntervalMs: 50,
  sigtermFlushTimeoutMs: 20,
  storeDir: "/tmp/unused",
};

// Every route authenticates , so every request here carries the bearer.
// inbound_auth.test.ts is what covers the rejection side.
const AUTH = { authorization: `Bearer ${CONFIG.sharedSecret}` };

let dir: string;
let supervisor: Supervisor;
const shipped: EventEnvelope[] = [];

function silentTransport(): Transport {
  return new Transport({
    railsInternalUrl: "http://rails:3000",
    sharedSecret: "s",
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-server-"));
  shipped.length = 0;

  supervisor = new Supervisor(silentTransport(), {
    storeDir: dir,
    adapters: {
      "anthropic-direct": {
        id: "anthropic-direct",
        displayName: "stub",
        entitlement: { credentialKind: "api_key", thirdPartyClientPermitted: "yes", note: "" },
        probe: async () => ({ available: true, credentialSource: "env:ANTHROPIC_API_KEY" }),
        listModels: async () => [],
        capabilities: () => stubCaps(),
        // Hangs until aborted, so the run stays ACTIVE for the endpoints under
        // test. A stream that simply returns settles the loop immediately and the
        // run is gone before the assertion — which is what four failures said.
        stream: (req: { signal: AbortSignal }) =>
          (async function* () {
            await new Promise<void>((resolve) => {
              if (req.signal.aborted) return resolve();
              req.signal.addEventListener("abort", () => resolve(), { once: true });
            });
          })(),
      },
    },
    buildLoop: ({ store, adapter, emit }) =>
      new RunLoop({
        store,
        adapter,
        tools: new (class extends Object {
          get() {
            return undefined;
          }
          policyFor() {
            return "never" as const;
          }
          schemasFor() {
            return [];
          }
          // biome-ignore lint/suspicious/noExplicitAny: minimal registry stand-in
        })() as any,
        emit: (events) => {
          shipped.push(...events);
          emit(events);
        },
      }),
  });
});

afterEach(async () => {
  await supervisor.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

function stubCaps() {
  return {
    streaming: true as const,
    toolUse: true as const,
    toolUseWhileStreaming: true,
    contextWindow: 1000,
    maxOutputTokens: 100,
    adaptiveThinking: false,
    thinkingDisplaySummarized: false,
    effortLevels: [],
    promptCaching: false,
    minCacheablePrefixTokens: null,
    serverSideCompaction: false,
    contextEditing: false,
    serverSideTools: { webSearch: false, webFetch: false, codeExecution: false },
    liveModelDiscovery: false,
    serverSideRefusalFallback: true,
    midConversationSystemMessages: true,
    midConversationToolChanges: true,
  };
}

function startBody(over: Record<string, unknown> = {}) {
  return {
    run_id: "1",
    session_id: "45",
    lane: "main",
    repo_path: dir,
    prompt: "go",
    requested_by: "7",
    provider: "anthropic-direct",
    model: "claude-opus-5",
    ...over,
  };
}

describe("Fastify server (supervisor-backed)", () => {
  it("GET /healthz reports active_run_ids", async () => {
    const app = buildServer(supervisor, CONFIG);
    const res = await app.inject({ method: "GET", url: "/healthz", headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ active_run_ids: [] });
    await app.close();
  });

  it("POST /runs accepts lane + provider and returns 202", async () => {
    const app = buildServer(supervisor, CONFIG);
    const res = await app.inject({
      method: "POST",
      url: "/runs",
      payload: startBody(),
      headers: AUTH,
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ run_id: "1", status: "running" });
    await app.close();
  });

  it("GET /runs is the authoritative active-run list", async () => {
    const app = buildServer(supervisor, CONFIG);
    await app.inject({ method: "POST", url: "/runs", payload: startBody(), headers: AUTH });

    const res = await app.inject({ method: "GET", url: "/runs", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().runs).toMatchObject([{ run_id: "1", session_id: "45", lane: "main" }]);
    await app.close();
  });

  it("refuses a second run on the SAME lane with 409", async () => {
    const app = buildServer(supervisor, CONFIG);
    await app.inject({ method: "POST", url: "/runs", payload: startBody(), headers: AUTH });

    const res = await app.inject({
      method: "POST",
      url: "/runs",
      payload: startBody({ run_id: "2" }),
      headers: AUTH,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "run_active" });
    await app.close();
  });

  it("allows a concurrent run on a DIFFERENT lane", async () => {
    // One-active-run is per LANE now, not per session (B5). Until M7 everything is
    // on "main", so this asserts the constraint moved rather than vanished.
    const app = buildServer(supervisor, CONFIG);
    await app.inject({ method: "POST", url: "/runs", payload: startBody(), headers: AUTH });

    const res = await app.inject({
      method: "POST",
      url: "/runs",
      payload: startBody({ run_id: "2", lane: "review" }),
      headers: AUTH,
    });
    expect(res.statusCode).toBe(202);
    await app.close();
  });

  it("POST /runs/:id/messages queues a follow-up on a live run", async () => {
    const app = buildServer(supervisor, CONFIG);
    await app.inject({ method: "POST", url: "/runs", payload: startBody(), headers: AUTH });

    const res = await app.inject({
      method: "POST",
      url: "/runs/1/messages",
      payload: { message: "also do this" },
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ run_id: "1", accepted: true });
    await app.close();
  });

  it("messages and interrupt to an unknown run are 404", async () => {
    const app = buildServer(supervisor, CONFIG);

    const messages = await app.inject({
      method: "POST",
      url: "/runs/nope/messages",
      payload: { message: "x" },
      headers: AUTH,
    });
    const interrupt = await app.inject({
      method: "POST",
      url: "/runs/nope/interrupt",
      headers: AUTH,
    });

    expect([messages.statusCode, interrupt.statusCode]).toEqual([404, 404]);
    expect(messages.json()).toEqual({ error: "unknown_run" });
    await app.close();
  });

  it("POST /runs/:id/permission_mode is GONE (404, not 200)", async () => {
    // B2. Asserted because a removal nothing tests quietly comes back — and the
    // web client stops sending it in the same change.
    const app = buildServer(supervisor, CONFIG);
    await app.inject({ method: "POST", url: "/runs", payload: startBody(), headers: AUTH });

    const res = await app.inject({
      method: "POST",
      url: "/runs/1/permission_mode",
      payload: { permission_mode: "acceptEdits" },
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  // 20s, not the 5s default: this route runs REAL provider discovery, so on a host with Bedrock
  // credentials it enumerates the live catalogue and takes seconds. It flaked once the suite grew
  // enough to contend for CPU — a timeout that depends on how many other tests are running is a
  // false red. (In CI there are no credentials, so every probe short-circuits.)
  it("GET /models returns the per-provider shape, never a bare array", async () => {
    const app = buildServer(supervisor, CONFIG);
    const res = await app.inject({ method: "GET", url: "/models", headers: AUTH });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(false);
    expect(Array.isArray(body.providers)).toBe(true);
    // An unavailable provider is reported, not omitted — so the list is never empty.
    expect(body.providers.length).toBeGreaterThan(0);
    expect(body.providers[0]).toHaveProperty("available");
    await app.close();
  }, 20_000);

  it("GET /sessions/:id/entries serves the PROJECTION, withholding store-only rows", async () => {
    const app = buildServer(supervisor, CONFIG);
    await app.inject({ method: "POST", url: "/runs", payload: startBody(), headers: AUTH });

    const res = await app.inject({ method: "GET", url: "/sessions/45/entries", headers: AUTH });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ session_id: "45", after: 0 });
    // Rails does NO filtering of its own, so a store-only entry escaping here would be
    // projected as a phantom event with nothing downstream to catch it.
    expect(body.entries.every((e: { emitted: number }) => e.emitted === 1)).toBe(true);
    await app.close();
  });

  it("treats ?after= as EXCLUSIVE, like every other projection cursor", async () => {
    const app = buildServer(supervisor, CONFIG);
    await app.inject({ method: "POST", url: "/runs", payload: startBody(), headers: AUTH });

    const all = await app.inject({ method: "GET", url: "/sessions/45/entries", headers: AUTH });
    const first = all.json().entries[0]?.store_seq as number;
    const after = await app.inject({
      method: "GET",
      url: `/sessions/45/entries?after=${first}`,
      headers: AUTH,
    });

    // Off-by-one here drops or duplicates exactly one event per request, which is the
    // hardest projection bug to see.
    expect(after.json().entries.map((e: { store_seq: number }) => e.store_seq)).not.toContain(
      first,
    );
    await app.close();
  });

  it("rejects a nonsense cursor instead of coercing it", async () => {
    const app = buildServer(supervisor, CONFIG);
    const res = await app.inject({
      method: "GET",
      url: "/sessions/45/entries?after=-1",
      headers: AUTH,
    });

    // `Number("abc")` is NaN and `Number("-1")` is negative; either would read as 0 and
    // silently re-derive the whole session when the caller asked for a slice.
    expect(res.statusCode).toBe(400);
    const bad = await app.inject({
      method: "GET",
      url: "/sessions/45/entries?after=abc",
      headers: AUTH,
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it("GET /connectors and /skills keep their pinned shapes", async () => {
    const app = buildServer(supervisor, CONFIG);
    const connectors = await app.inject({
      method: "GET",
      url: "/connectors?cwd=/tmp",
      headers: AUTH,
    });
    const skills = await app.inject({ method: "GET", url: "/skills?cwd=/tmp", headers: AUTH });

    expect(connectors.statusCode).toBe(200);
    expect(skills.statusCode).toBe(200);
    expect(connectors.json()).toHaveProperty("connectors");
    expect(skills.json()).toHaveProperty("skills");
    await app.close();
  });
});

describe("config", () => {
  it("reads RAILS_INTERNAL_URL and defaults the store OUTSIDE any project tree", () => {
    const config = loadConfig({ RAILS_INTERNAL_URL: "http://elsewhere:3000" });

    expect(config.railsInternalUrl).toBe("http://elsewhere:3000");
    // A store under a worktree would be committed, reverted by a reject, or
    // deleted with the worktree.
    expect(config.storeDir).toMatch(/\.local\/state\/clawdparty\/sessions$/);
  });

  it("honours HARNESS_STORE_DIR", () => {
    expect(loadConfig({ HARNESS_STORE_DIR: "/custom/store" }).storeDir).toBe("/custom/store");
  });
});

describe("heartbeat", () => {
  const stub = {
    activeRunIds: () => ["1"],
    storeSeqHighWater: () => ({ "1": 42 }),
    heartbeat: () => {},
  };

  it("POSTs to /internal/harness/heartbeat with store_seq_high_water", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: 200 });
    });

    const beat = startHeartbeat(CONFIG, silentLogger(), stub, fetchImpl as unknown as typeof fetch);
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    beat.stop();

    // Renamed path (B4) and the new field Rails uses to detect projection lag.
    expect(calls[0]?.url).toBe("http://rails:3000/internal/harness/heartbeat");
    expect(calls[0]?.body).toEqual({
      active_run_ids: ["1"],
      store_seq_high_water: { "1": 42 },
    });
  });

  it("treats a 401 as fatal and stops beating", async () => {
    let count = 0;
    const fetchImpl = vi.fn(async () => {
      count += 1;
      return new Response("{}", { status: 401 });
    });

    const beat = startHeartbeat(CONFIG, silentLogger(), stub, fetchImpl as unknown as typeof fetch);
    await vi.waitFor(() => expect(count).toBe(1));
    await new Promise((r) => setTimeout(r, CONFIG.heartbeatIntervalMs * 3));
    beat.stop();

    // Retrying a misroute forever is indistinguishable from an outage.
    expect(count).toBe(1);
  });

  it("does not crash when Rails is unreachable (transient)", async () => {
    let count = 0;
    const fetchImpl = vi.fn(async () => {
      count += 1;
      throw new Error("ECONNREFUSED");
    });

    const beat = startHeartbeat(CONFIG, silentLogger(), stub, fetchImpl as unknown as typeof fetch);
    await vi.waitFor(() => expect(count).toBeGreaterThan(1));
    beat.stop();
  });
});

describe("SIGTERM flush is bounded", () => {
  it("returns within the timeout even if the flush hangs", async () => {
    const transport = {
      flush: () => new Promise<never>(() => {}),
      flushEphemeral: () => new Promise<never>(() => {}),
    } as unknown as Transport;

    const started = Date.now();
    await flushWithTimeout(transport, 20);

    expect(Date.now() - started).toBeLessThan(500);
  });
});

function silentLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    // biome-ignore lint/suspicious/noExplicitAny: Fastify's logger type is broad
  } as any;
}
