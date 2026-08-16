// index.ts — the Fastify server + heartbeat loop. Deals only in Contract-1
// envelopes and HTTP. It drives no provider directly (that is loop/run_loop.ts via
// supervisor.ts) and knows no vendor shapes (that is providers/*).
//
// Endpoint changes at the harness migration (docs/contracts/CHANGELOG.md, B1-B4):
//   POST /runs                    takes `lane` + `provider`, drops claude_session_id
//   GET  /runs                    NEW — the authoritative active-run list
//   POST /runs/:id/permission_mode REMOVED — an Agent SDK concept
//   GET  /models                  per-provider shape

import Fastify, { type FastifyInstance } from "fastify";
import { listConnectors, listSkills } from "./capabilities.js";
import { type HarnessConfig, loadConfig } from "./config.js";
import { listProviders } from "./providers/discovery.js";
import { RunConflict, type StartRunInput, Supervisor, UnknownRun } from "./supervisor.js";
import { Transport } from "./transport.js";

export function buildServer(supervisor: Supervisor): FastifyInstance {
  const app = Fastify({ logger: true });

  // Liveness probe — reports the supervisor's real active runs.
  app.get("/healthz", async () => ({ active_run_ids: supervisor.activeRunIds() }));

  /**
   * The  reconciliation source. Rails calls this on boot and reconciles
   * `ai_runs` to the answer — THE HARNESS WINS, because it holds the record and
   * Rails holds a projection of it. Read from the position registers, never
   * inferred from the log.
   */
  app.get("/runs", async () => ({ runs: supervisor.activeRuns() }));

  /**
   * Per-provider model discovery. Never 500s, and an unavailable provider is
   * REPORTED rather than omitted  — omitting it is what produces "the
   * picker is just empty" with no way to learn why.
   */
  app.get("/models", async () => listProviders());

  // GET /connectors?cwd= / GET /skills?cwd= — read-only, cwd-scoped discovery.
  app.get<{ Querystring: { cwd?: string } }>("/connectors", async (req) =>
    listConnectors(req.query.cwd ?? process.cwd()),
  );
  app.get<{ Querystring: { cwd?: string } }>("/skills", async (req) =>
    listSkills(req.query.cwd ?? process.cwd()),
  );

  // POST /runs — start a run. 202 on accept; 409 when the LANE already has one.
  app.post("/runs", async (req, reply) => {
    const input = req.body as StartRunInput;
    try {
      await supervisor.startRun(input);
      return reply.code(202).send({ run_id: input.run_id, status: "running" });
    } catch (err) {
      if (err instanceof RunConflict) {
        return reply.code(409).send({ error: "run_active" });
      }
      throw err;
    }
  });

  // POST /runs/:id/messages — follow-up into the live run. 200 / 404. The message
  // lands in the loop's inbox and is appended to the record at the next turn
  // boundary, so it survives a crash between arrival and use.
  app.post<{ Params: { id: string }; Body: { message: string } }>(
    "/runs/:id/messages",
    async (req, reply) => {
      try {
        supervisor.sendMessage(req.params.id, req.body.message);
        return reply.code(200).send({ run_id: req.params.id, accepted: true });
      } catch (err) {
        if (err instanceof UnknownRun) {
          return reply.code(404).send({ error: "unknown_run" });
        }
        throw err;
      }
    },
  );

  // POST /runs/:id/interrupt — interrupt the live run. 200 / 404.
  app.post<{ Params: { id: string } }>("/runs/:id/interrupt", async (req, reply) => {
    try {
      await supervisor.interrupt(req.params.id);
      return reply.code(200).send({ run_id: req.params.id, accepted: true });
    } catch (err) {
      if (err instanceof UnknownRun) {
        return reply.code(404).send({ error: "unknown_run" });
      }
      throw err;
    }
  });

  return app;
}

/**
 * Heartbeat: POST { active_run_ids, store_seq_high_water } every 5s, bearer-authed.
 *
 * `store_seq_high_water` is new (B4): it lets Rails detect projection lag without
 * polling. The path is `/internal/harness/heartbeat` — renamed from
 * `/internal/harness/heartbeat` inside the declared window.
 *
 * 5xx/network is transient (keep going); 401/403/404 is a FATAL misconfiguration —
 * retrying a misroute forever looks identical to an outage, which is why it stops.
 */
export function startHeartbeat(
  config: HarnessConfig,
  logger: FastifyInstance["log"],
  supervisor: Pick<Supervisor, "activeRunIds" | "storeSeqHighWater" | "heartbeat">,
  fetchImpl: typeof fetch = fetch,
): { stop: () => void } {
  let fatal = false;

  const beat = async (): Promise<void> => {
    if (fatal) return;
    // Refresh the session locks in the same tick, so a live writer is never
    // reclaimed as stale by another process.
    supervisor.heartbeat();
    try {
      const res = await fetchImpl(`${config.railsInternalUrl}/internal/harness/heartbeat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.sharedSecret}`,
        },
        body: JSON.stringify({
          active_run_ids: supervisor.activeRunIds(),
          store_seq_high_water: supervisor.storeSeqHighWater(),
        }),
      });
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        fatal = true;
        logger.error(
          { status: res.status },
          "FATAL: heartbeat rejected (auth/misroute) — not retrying as a transient outage",
        );
      }
    } catch (err) {
      logger.warn({ err: String(err) }, "heartbeat failed (transient); will retry");
    }
  };

  const timer = setInterval(() => void beat(), config.heartbeatIntervalMs);
  void beat();
  return { stop: () => clearInterval(timer) };
}

// Bounded best-effort flush on SIGTERM: try to drain the transport buffer, but exit
// once the timeout elapses so shutdown cannot hang. The RECORD is already durable —
// this only concerns the projection channel.
export async function flushWithTimeout(transport: Transport, timeoutMs: number): Promise<void> {
  await Promise.race([
    transport.flush(),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

export function buildSupervisor(
  config: HarnessConfig,
  logger: FastifyInstance["log"],
): { supervisor: Supervisor; transport: Transport } {
  const transport = new Transport({
    railsInternalUrl: config.railsInternalUrl,
    sharedSecret: config.sharedSecret,
    logger,
  });
  const supervisor = new Supervisor(transport, { storeDir: config.storeDir });
  return { supervisor, transport };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const app0 = Fastify({ logger: true });
  const { supervisor, transport } = buildSupervisor(config, app0.log);
  const app = buildServer(supervisor);

  const heartbeat = startHeartbeat(config, app.log, supervisor);

  const shutdown = async (): Promise<void> => {
    heartbeat.stop();
    await supervisor.shutdown();
    await flushWithTimeout(transport, config.sigtermFlushTimeoutMs);
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  // Still 0.0.0.0 while the harness is a compose service; a follow-up moves it to
  // 127.0.0.1 as part of the host move, which is when loopback-only matters.
  await app.listen({ port: config.port, host: "0.0.0.0" });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`harness failed to start: ${String(err)}\n`);
    process.exit(1);
  });
}
