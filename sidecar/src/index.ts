// index.ts — the Fastify server + heartbeat loop. Deals only in Contract-1
// envelopes and HTTP; it never touches raw SDK shapes (that is normalizer.ts).
//
// W1 skeleton: run-control routes are 501 stubs (wired to the runner in W2);
// healthz/heartbeat report an empty active-run set. Binds 0.0.0.0:8787 and
// publishes no port itself (the unpublished-port guarantee is dev-docker-compose's).

import Fastify, { type FastifyInstance } from "fastify";
import { type SidecarConfig, loadConfig } from "./config.js";
import { Transport } from "./transport.js";

// W1 has no runner, so there are never any active runs.
function activeRunIds(): string[] {
  return [];
}

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });

  // Liveness probe — no auth, reports active runs (empty in the skeleton).
  app.get("/healthz", async () => ({ active_run_ids: activeRunIds() }));

  // Run-control stubs matching the frozen sidecar-protocol signatures. W1: 501.
  // W2 fills the handler bodies (202 for /runs, 200 for messages/interrupt)
  // WITHOUT changing these signatures.
  const notImplemented = { error: "not_implemented", detail: "wired to the runner in Week 2" };
  app.post("/runs", async (_req, reply) => reply.code(501).send(notImplemented));
  app.post("/runs/:id/messages", async (_req, reply) => reply.code(501).send(notImplemented));
  app.post("/runs/:id/interrupt", async (_req, reply) => reply.code(501).send(notImplemented));

  return app;
}

// Heartbeat: POST { active_run_ids } every 5s, bearer-authed. 5xx/network is
// transient (keep going); 401/403/404 is a FATAL misconfiguration (log + surface,
// do not retry forever).
export function startHeartbeat(
  config: SidecarConfig,
  logger: FastifyInstance["log"],
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

async function main(): Promise<void> {
  const config = loadConfig();
  const app = buildServer();
  const transport = new Transport({
    railsInternalUrl: config.railsInternalUrl,
    sharedSecret: config.sharedSecret,
    logger: app.log,
  });

  const heartbeat = startHeartbeat(config, app.log);

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
