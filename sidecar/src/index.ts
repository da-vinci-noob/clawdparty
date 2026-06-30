// index.ts — the Fastify server + heartbeat loop. Deals only in Contract-1
// envelopes and HTTP; it never touches raw SDK shapes (that is normalizer.ts) and
// never drives the SDK directly (that is runner.ts). Binds 0.0.0.0:8787 and
// publishes no port itself (the unpublished-port guarantee is dev-docker-compose's).
//
// Run-control routes are backed by the Runner: POST /runs → 202, follow-up +
// interrupt → 200, matching the frozen sidecar-protocol. /healthz and the
// heartbeat report the runner's real active_run_ids.

import Fastify, { type FastifyInstance } from "fastify";
import { type SidecarConfig, loadConfig } from "./config.js";
import { type QueryFn, RunConflict, Runner, type StartRunInput, UnknownRun } from "./runner.js";
import { Transport } from "./transport.js";

export function buildServer(runner: Runner): FastifyInstance {
  const app = Fastify({ logger: true });

  // Liveness probe — no auth, reports the runner's real active runs.
  app.get("/healthz", async () => ({ active_run_ids: runner.activeRunIds() }));

  // POST /runs — start a run. 202 on accept; 409 when a run is already active.
  app.post("/runs", async (req, reply) => {
    const input = req.body as StartRunInput;
    try {
      runner.startRun(input);
      return reply.code(202).send({ run_id: input.run_id, status: "running" });
    } catch (err) {
      if (err instanceof RunConflict) {
        return reply.code(409).send({ error: "run_active" });
      }
      throw err;
    }
  });

  // POST /runs/:id/messages — follow-up into the live run. 200 / 404.
  app.post<{ Params: { id: string }; Body: { message: string } }>(
    "/runs/:id/messages",
    async (req, reply) => {
      try {
        runner.sendMessage(req.params.id, req.body.message);
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
      await runner.interrupt(req.params.id);
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

// Heartbeat: POST { active_run_ids } every 5s, bearer-authed. 5xx/network is
// transient (keep going); 401/403/404 is a FATAL misconfiguration (log + surface,
// do not retry forever). `activeRunIds` is read live from the runner each beat.
export function startHeartbeat(
  config: SidecarConfig,
  logger: FastifyInstance["log"],
  activeRunIds: () => string[],
  fetchImpl: typeof fetch = fetch,
): { stop: () => void } {
  let fatal = false;

  const beat = async (): Promise<void> => {
    if (fatal) return;
    try {
      const res = await fetchImpl(`${config.railsInternalUrl}/internal/sidecar/heartbeat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.sharedSecret}`,
        },
        body: JSON.stringify({ active_run_ids: activeRunIds() }),
      });
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        fatal = true;
        logger.error(
          { status: res.status },
          "FATAL: heartbeat rejected (auth/misroute) — not retrying as a transient outage",
        );
      }
    } catch (err) {
      // Transient: Rails down/unreachable. Keep beating on cadence; never crash.
      logger.warn({ err: String(err) }, "heartbeat failed (transient); will retry");
    }
  };

  const timer = setInterval(() => void beat(), config.heartbeatIntervalMs);
  void beat(); // fire one immediately
  return { stop: () => clearInterval(timer) };
}

// Bounded best-effort flush on SIGTERM: try to drain the transport buffer, but
// exit once the timeout elapses so shutdown cannot hang. Does NOT finalize run
// state (Rails finalizes an interrupted run).
export async function flushWithTimeout(transport: Transport, timeoutMs: number): Promise<void> {
  await Promise.race([
    transport.flush(),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

export function buildRunner(
  config: SidecarConfig,
  logger: FastifyInstance["log"],
  queryFn?: QueryFn,
): {
  runner: Runner;
  transport: Transport;
} {
  const transport = new Transport({
    railsInternalUrl: config.railsInternalUrl,
    sharedSecret: config.sharedSecret,
    logger,
  });
  const runner = queryFn ? new Runner(transport, queryFn) : new Runner(transport);
  return { runner, transport };
}

async function main(): Promise<void> {
  const config = loadConfig();
  // A logger to build the transport/runner before the server exists; Fastify
  // reuses pino under the hood, so use a Fastify instance's logger.
  const app0 = Fastify({ logger: true });
  const { runner, transport } = buildRunner(config, app0.log);
  const app = buildServer(runner);

  const heartbeat = startHeartbeat(config, app.log, () => runner.activeRunIds());

  const shutdown = async (): Promise<void> => {
    heartbeat.stop();
    await flushWithTimeout(transport, config.sigtermFlushTimeoutMs);
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  // Bind 0.0.0.0 so the published/compose-network port reaches it.
  await app.listen({ port: config.port, host: "0.0.0.0" });
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`sidecar failed to start: ${String(err)}\n`);
    process.exit(1);
  });
}
