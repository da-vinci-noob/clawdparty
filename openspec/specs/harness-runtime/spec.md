# harness-runtime Specification

## Purpose
TBD - created by archiving change harness-foundation. Update Purpose after archive.
## Requirements
### Requirement: Fastify HTTP server on the unpublished compose-network port

The harness SHALL run a Fastify HTTP server (Node 24, TypeScript) listening on port **8787**. The harness's testable obligation is to bind `0.0.0.0:8787` and to publish no port itself, so the server is reachable over the Docker compose network as `http://harness:8787` from the `rails` service container, consistent with the `harness-protocol` capability's compose-network addressing. The LAN/host unreachability is a property of the dev-docker-compose topology (the port is left unpublished) and is owned and verified by the `dev-docker-compose` change, not by harness code.

#### Scenario: Harness is reachable from Rails over the compose network

- **WHEN** the `rails` service issues a request to `http://harness:8787`
- **THEN** the harness Fastify server accepts it on port 8787

#### Scenario: Harness binds 0.0.0.0:8787 and declares no published port

- **WHEN** the harness starts its Fastify server
- **THEN** it binds `0.0.0.0:8787` and declares no published port itself, leaving the LAN/host-unreachability guarantee (the unpublished port) to be owned and verified by the `dev-docker-compose` change

### Requirement: Healthz reports active runs

The harness SHALL expose `GET /healthz` returning the set of active run ids as `active_run_ids` (the same key the heartbeat uses), per the `harness-protocol` capability. In the Week-1 skeleton, with no runner present, `active_run_ids` SHALL be empty. The endpoint SHALL respond without requiring authentication so it can serve as a liveness probe.

#### Scenario: Healthz returns active run ids

- **WHEN** a `GET /healthz` request is received
- **THEN** the harness responds successfully with the current `active_run_ids`

#### Scenario: Healthz reports no active runs in the skeleton

- **WHEN** `GET /healthz` is called and no runner is wired (Week-1 skeleton)
- **THEN** `active_run_ids` is empty

### Requirement: Run-control route stubs

The harness SHALL expose `POST /runs`, `POST /runs/:id/messages`, and `POST /runs/:id/interrupt` matching the request signatures defined in the `harness-protocol` capability. In the Week-1 skeleton these routes SHALL be stubs: they exist and parse their requests but do not execute a run. Each stub SHALL return a defined not-yet-implemented response with an explicit status code (**501 Not Implemented** in W1) rather than an undefined or empty shape, and SHALL NOT perform any run lifecycle work. In Week 2 these handler bodies SHALL be replaced by the frozen `harness-protocol` success shapes (`202 Accepted` for `POST /runs`, `200 OK` for `POST /runs/:id/messages` and `POST /runs/:id/interrupt`) without changing the route signatures.

#### Scenario: Run-control routes exist with the contract signatures

- **WHEN** Rails issues `POST /runs`, `POST /runs/:id/messages`, or `POST /runs/:id/interrupt`
- **THEN** the route exists and matches the `harness-protocol` signature
- **AND** in the skeleton it returns a defined `501 Not Implemented` response without running Claude

#### Scenario: Route signatures are stable into Week 2

- **WHEN** the runner is wired in Week 2
- **THEN** the run-control route signatures are unchanged from the skeleton, only their handler bodies are filled in

### Requirement: Heartbeat to Rails every 5 seconds

The harness SHALL POST `POST /internal/harness/heartbeat` to Rails every 5 seconds carrying the current `active_run_ids`, per the `harness-protocol` capability. The request body SHALL be the frozen `{ active_run_ids: [...] }` shape and the heartbeat SHALL be bearer-authenticated with `HARNESS_SHARED_SECRET`; a successful heartbeat responds `200 { ok: true }`. In the Week-1 skeleton `active_run_ids` SHALL be empty. Consistent with the transport's response classification, the harness SHALL treat a **401** (bad or missing `HARNESS_SHARED_SECRET`), **403** (forbidden), or **404** (heartbeat endpoint not found / misrouted) response from the heartbeat as a fatal misconfiguration — an authentication error for 401 and a misroute/misconfiguration error for 403/404 — and SHALL log a fatal error and surface the condition rather than retrying the heartbeat forever as if it were a transient Rails outage. Transient failures (5xx or network error) SHALL NOT be treated as fatal; the heartbeat loop keeps attempting on its cadence.

#### Scenario: Heartbeat is emitted on a 5-second cadence

- **WHEN** the harness is running
- **THEN** it POSTs `/internal/harness/heartbeat` to Rails every 5 seconds with the body `{ active_run_ids: [...] }` and the `HARNESS_SHARED_SECRET` bearer token

#### Scenario: Heartbeat continues while Rails is unavailable

- **WHEN** Rails is temporarily unreachable
- **THEN** the heartbeat loop keeps attempting on its 5-second cadence and does not crash the harness

#### Scenario: Heartbeat 4xx is a fatal misconfiguration

- **WHEN** a heartbeat POST receives a 401 (bad or missing `HARNESS_SHARED_SECRET`), 403 (forbidden), or 404 (heartbeat endpoint not found / misrouted)
- **THEN** the harness logs a fatal misconfiguration error — an authentication error for 401 and a misroute error for 403/404 — and surfaces the condition
- **AND** it does NOT retry the heartbeat forever as if it were a transient Rails outage, mirroring the transport's response classification

### Requirement: Configurable Rails callback base URL and no hard-coded host

The harness SHALL read the Rails callback base URL for the harness→Rails direction from a dedicated configuration variable (e.g. `RAILS_INTERNAL_URL`) and SHALL NOT hard-code a fixed Rails host or assume loopback, consistent with the `harness-protocol` capability's no-hard-coded-host rule. This callback variable SHALL be distinct from `HARNESS_URL` — `HARNESS_URL` is the Rails→harness address per the frozen `harness-protocol`, so the two directions SHALL NOT be conflated onto a single variable. This keeps remote/Tailscale operation a future drop-in.

#### Scenario: Rails base URL comes from configuration

- **WHEN** the harness needs to POST events or heartbeats to Rails
- **THEN** it uses the configured `RAILS_INTERNAL_URL` callback base URL rather than a hard-coded address

#### Scenario: Callback variable is distinct from HARNESS_URL

- **WHEN** the harness resolves its harness→Rails callback base URL
- **THEN** it reads `RAILS_INTERNAL_URL` and SHALL NOT reuse `HARNESS_URL` (which is the Rails→harness address per the frozen `harness-protocol`)

### Requirement: Biome, strict TypeScript, Vitest, and a Node-pinned CI job

The `harness/` package SHALL use Biome for lint/format (2-space, double quotes, semicolons, with `noExplicitAny`, `useImportType`, and `noConsole: error`), strict TypeScript (`strict`, `isolatedModules`), and Vitest for tests. The CI `harness` job SHALL run Biome + `tsc` + Vitest and SHALL be pinned to **Node 24** even though the host runs Node 25, to avoid version drift. Server, heartbeat, and buffer-state logging SHALL use the structured logger (Fastify's built-in pino), NOT `console.*`, so `noConsole: error` is satisfied without blocking day-one CI.

#### Scenario: CI harness job runs the three checks on pinned Node

- **WHEN** the CI `harness` job runs
- **THEN** it runs Biome, `tsc`, and Vitest on Node 24

#### Scenario: Tooling matches the repo-wide conventions

- **WHEN** harness source is linted/formatted
- **THEN** Biome enforces 2-space indentation, double quotes, semicolons, `noExplicitAny`, `useImportType`, and `noConsole: error`

### Requirement: Best-effort transport flush on SIGTERM and the interrupt-finalize boundary

On receiving `SIGTERM`, the harness SHALL make a best-effort flush of its transport buffer (POST any pending durable events to Rails) before exiting; full graceful-drain semantics (bounded drain window, in-flight run handling) are explicitly deferred to W3. The best-effort flush SHALL be bounded by a timeout (e.g. a few seconds), after which the harness SHALL exit regardless of whether the flush completed, so shutdown cannot hang. The harness SHALL NOT finalize run state on shutdown or on interrupt: Rails — not the harness — finalizes an interrupted-and-dirty run to `awaiting_review`; the harness only emits the `run_interrupted` event.

#### Scenario: Harness flushes pending events on SIGTERM

- **WHEN** the harness receives `SIGTERM` with unsent durable events in its transport buffer
- **THEN** it makes a best-effort POST of those events to Rails before exiting, deferring full graceful-drain to W3

#### Scenario: SIGTERM flush is bounded and cannot hang shutdown

- **WHEN** the best-effort flush on `SIGTERM` does not complete within its timeout (e.g. Rails is unreachable)
- **THEN** the harness exits anyway once the timeout elapses rather than hanging shutdown waiting on the flush

#### Scenario: Harness does not finalize an interrupted run

- **WHEN** a run is interrupted
- **THEN** the harness only emits a `run_interrupted` event and SHALL NOT transition the run to `awaiting_review` — Rails performs that finalization

