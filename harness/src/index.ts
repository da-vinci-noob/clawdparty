// index.ts — the Fastify server + heartbeat loop. Deals only in Contract-1
// envelopes and HTTP. It drives no provider directly (that is loop/run_loop.ts via
// supervisor.ts) and knows no vendor shapes (that is providers/*).
//
// Endpoint changes at the harness migration (docs/contracts/CHANGELOG.md, B1-B4):
//   POST /runs                    takes `lane` + `provider`, drops claude_session_id
//   GET  /runs                    NEW — the authoritative active-run list
//   POST /runs/:id/permission_mode REMOVED — an Agent SDK concept
//   GET  /models                  per-provider shape

import { existsSync, readFileSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import { bearerToken, tokenMatches } from "./auth.js";
import { listAwsProfiles, listConnectors, listSkills } from "./capabilities.js";
import { type HarnessConfig, loadConfig } from "./config.js";
import { listProviders } from "./providers/discovery.js";
import { verifyProviders } from "./providers/verify.js";
import { RunConflict, type StartRunInput, Supervisor, UnknownRun } from "./supervisor.js";
import { Transport } from "./transport.js";

export function buildServer(
  supervisor: Supervisor,
  config: Pick<HarnessConfig, "sharedSecret">,
): FastifyInstance {
  const app = Fastify({ logger: true });

  /**
   * EVERY route authenticates, `/healthz` included  — there is no exempt
   * probe, because nothing needs one: supervision is process-level (launchd
   * KeepAlive / systemd Restart), not an HTTP poll, and `bin/harness status` reads
   * the same `.env.local` the secret is generated into. Exempting `/healthz` would
   * hand `active_run_ids` to any local process for no consumer's benefit.
   */
  app.addHook("onRequest", async (req, reply) => {
    if (tokenMatches(bearerToken(req.headers.authorization) ?? "", config.sharedSecret)) return;

    // No detail about which part failed: absent, malformed, and wrong all look
    // identical to a caller.
    await reply.code(401).send({ error: "unauthorized" });
  });

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

  /**
   * POST /verify — does a provider ACTUALLY work?
   *
   * A POST, not a GET, because it is not a read: it sends a real (tiny) request to each provider,
   * which is the only thing that distinguishes "a credential is present" from "the credential is
   * accepted". `/models` answers the first — measured cases where that was not enough: an
   * entitlement refusal on nova-premier with a valid credential, and a configured MCP server
   * answering `invalid_token`.
   */
  app.post("/verify", async () => verifyProviders());

  // GET /connectors?cwd= / GET /skills?cwd= — read-only, cwd-scoped discovery.
  app.get<{ Querystring: { cwd?: string } }>("/connectors", async (req) =>
    listConnectors(req.query.cwd ?? process.cwd()),
  );
  app.get<{ Querystring: { cwd?: string } }>("/skills", async (req) =>
    listSkills(req.query.cwd ?? process.cwd()),
  );

  /**
   * GET /aws-profiles — names the host has in `~/.aws/config`, for the Bedrock profile setting.
   *
   * Names only; `~/.aws/credentials` is never opened. Enumerated so the setting is a choice
   * among what exists rather than free text that fails later as an opaque AWS error.
   */
  app.get("/aws-profiles", async () => listAwsProfiles());

  /**
   * The re-derivation source. `?after=` is EXCLUSIVE, matching the
   * projection cursor everywhere else; the inclusive/exclusive conversion lives in
   * `afterCursorToFrom` and nowhere else, because splitting it silently drops or
   * duplicates exactly one event per request.
   *
   * Serves the PROJECTION, so store-only entries never leave the harness — Rails does
   * no filtering of its own and cannot accidentally get it wrong.
   */
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    "/sessions/:id/entries",
    async (req, reply) => {
      const after = Number(req.query.after ?? 0);
      if (!Number.isInteger(after) || after < 0) {
        return reply.code(400).send({ error: "after must be a non-negative integer" });
      }
      try {
        const entries = await supervisor.projectionEntries(req.params.id, after);
        return reply.code(200).send({ session_id: req.params.id, after, entries });
      } catch (err) {
        // An unknown session and a store held by another writer both mean "cannot read
        // this record now". Reported rather than thrown as a 500: a re-derivation that
        // 500s reads as a harness fault when it is a state a caller can retry.
        return reply.code(409).send({ error: "store_unavailable", detail: String(err) });
      }
    },
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
 * `store_seq_high_water` (B4) lets Rails detect projection lag without polling.
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
    // The ephemeral queue holds up to one coalescing window of streamed text. On a SIGTERM
    // mid-turn no `ai_text` block-stop will ever follow it, so this drain is the only thing
    // that gets the last partial sentence to the room.
    Promise.all([transport.flush(), transport.flushEphemeral()]),
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

/**
 * The harness runs on the HOST. Starting inside a container is a
 * misconfiguration whose symptoms are confusing rather than obvious: credential
 * discovery reads paths that only exist on the host , the store lands in a
 * layer that vanishes on restart, and `cwd` from a run-start payload is a host path
 * that may not resolve. Each of those fails later and elsewhere, so it is refused
 * here instead.
 */
export function containerMarkers(fs: {
  exists: (p: string) => boolean;
  read: (p: string) => string;
}): string[] {
  const found: string[] = [];
  if (fs.exists("/.dockerenv")) found.push("/.dockerenv exists");
  // A containerized PID 1 shows its runtime in its own cgroup path. Read cgroup
  // rather than /proc/1/cgroup alone so cgroup v2 (a single `0::/` line) still
  // reports via the marker file above rather than a false negative here.
  const cgroup = fs.read("/proc/self/cgroup");
  if (/docker|containerd|kubepods|libpod/.test(cgroup))
    found.push("container runtime in /proc/self/cgroup");
  return found;
}

function hostFsProbe(): { exists: (p: string) => boolean; read: (p: string) => string } {
  return {
    exists: (p) => existsSync(p),
    read: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return "";
      }
    },
  };
}

async function main(): Promise<void> {
  const config = loadConfig();

  const markers = containerMarkers(hostFsProbe());
  if (markers.length > 0) {
    process.stderr.write(
      `harness refuses to start inside a container (${markers.join("; ")}).
Supported topology: the harness runs as a HOST process (bin/harness); rails, jobs and
postgres stay containerized. See docs/contracts/harness_protocol.md.
`,
    );
    process.exit(1);
  }

  // A missing secret would leave the control surface open were it not for the
  // fail-closed compare in auth.ts — which turns it into "every request 401s", a
  // symptom that reads like a bug. Fail here, where the message can name the fix.
  if (config.sharedSecret.length === 0) {
    process.stderr.write(
      "HARNESS_SHARED_SECRET is unset or empty — run bin/setup to generate it.\n",
    );
    process.exit(1);
  }

  const app0 = Fastify({ logger: true });
  const { supervisor, transport } = buildSupervisor(config, app0.log);

  // RECOVER BEFORE SERVING. Rails reconciles against GET /runs at boot
  // and treats an empty answer as "nothing active", so answering before recovery would
  // have it fail the very runs about to be recovered.
  const recovered = await supervisor.recoverAll();
  for (const { sessionId, outcome } of recovered) {
    app0.log.info(
      { sessionId, from: outcome.fromPhase, action: outcome.action, uncertain: outcome.uncertain },
      outcome.uncertain
        ? "recovered a run with an UNKNOWN outcome (request in flight at crash)"
        : "recovered a run",
    );
  }

  const app = buildServer(supervisor, config);

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

  // LOOPBACK ONLY, never 0.0.0.0. The containerized services reach
  // this through the Docker bridge, which on Docker Desktop proxies to host
  // loopback; on Linux the bridge does NOT, which is why HARNESS_BIND_HOST exists
  // (see docker-compose.yml `extra_hosts`). Nothing on the LAN can reach it either
  // way — `rails:3000` stays the single published surface.
  await app.listen({ port: config.port, host: config.bindHost });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`harness failed to start: ${String(err)}\n`);
    process.exit(1);
  });
}
