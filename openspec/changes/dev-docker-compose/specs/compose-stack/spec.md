## ADDED Requirements

### Requirement: Five services, one process per container

`docker-compose.yml` SHALL define exactly five services — `rails`, `jobs`, `postgres`, `sidecar`, and `vite` — and each service SHALL run a single process. The `rails` service SHALL run Puma, the `jobs` service SHALL run the Solid Queue supervisor (`bin/jobs`), the `postgres` service SHALL run PostgreSQL, the `sidecar` service SHALL run the Node Fastify server, and the `vite` service SHALL run the Vite dev server. No single service SHALL run more than one of these processes.

#### Scenario: Each architecture process maps to its own service

- **WHEN** the compose stack is brought up
- **THEN** `rails`, `jobs`, `postgres`, `sidecar`, and `vite` each run as a separate service running exactly one process

#### Scenario: No combined all-in-one container

- **WHEN** the compose file is inspected
- **THEN** no service runs both Puma and the jobs supervisor (or any other two of the five processes) in one container

### Requirement: rails and jobs share one image

The `rails` and `jobs` services SHALL be built from the same Ruby image (the application image) and SHALL differ only in their start command — `rails` runs Puma, `jobs` runs `bin/jobs`. The `jobs` service SHALL NOT publish any port.

#### Scenario: jobs reuses the rails image with a different command

- **WHEN** the stack is built
- **THEN** `jobs` uses the same application image as `rails` and starts the Solid Queue supervisor (`bin/jobs`) instead of Puma, with no published port

### Requirement: jobs does not assume the queue database exists at boot

The `jobs` service (Solid Queue supervisor) SHALL NOT assume the queue database exists when it boots. Because only the `rails` entrypoint runs DB-prepare, `jobs` SHALL either `depends_on` the database being ready (at minimum `postgres` with a `service_healthy` condition, and ideally ordered after the `rails` entrypoint's DB-prepare has completed) **or** adopt a restart-until-ready posture so it retries until the queue database has been created and migrated. This prevents `jobs` from crash-looping or erroring on a missing queue database when it starts before `rails` has prepared it.

#### Scenario: jobs waits for the queue database

- **WHEN** the stack starts and `jobs` boots before the queue database has been created
- **THEN** `jobs` does not assume the queue database exists — it depends on `postgres` health (ideally ordered after the `rails` DB-prepare) or restarts-until-ready, so it only runs once the queue database is available

### Requirement: postgres uses PostgreSQL 18 with a named-volume data dir and a healthcheck

The `postgres` service SHALL use PostgreSQL 18 and SHALL store its data directory in a **named volume** so the database persists across container restarts and `docker compose up`/`down` cycles. The service SHALL define a healthcheck (e.g. `pg_isready`) that other services can gate on.

#### Scenario: Database data survives a restart

- **WHEN** the stack is stopped and started again with `bin/start`
- **THEN** the PostgreSQL data persists because it lives in a named volume, not an ephemeral container layer

#### Scenario: postgres reports health

- **WHEN** PostgreSQL has finished starting up
- **THEN** its healthcheck reports healthy so dependent services may start

### Requirement: postgres sets a connection identity so the image initializes and the connect-as role can create databases

The `postgres` service SHALL set `POSTGRES_HOST_AUTH_METHOD=trust` so the official `postgres:18` image initializes without requiring a password (the trusted-LAN perimeter is the security boundary per the security model, so no password management is needed). The service SHALL also set a fixed `POSTGRES_USER=postgres` and `POSTGRES_DB=postgres` default so the connect-as `postgres` superuser exists and holds CREATE-DATABASE privilege, which the `rails` entrypoint's three-database `db:prepare` requires. Without these, the image refuses to initialize and the first-boot `db:prepare` cannot create the queue and cable databases.

#### Scenario: postgres initializes under trust auth with a CREATE-DATABASE superuser

- **WHEN** the `postgres` service starts on first boot
- **THEN** `POSTGRES_HOST_AUTH_METHOD=trust` lets the image initialize without a password, and the `POSTGRES_USER=postgres` superuser exists with CREATE-DATABASE privilege so the `rails` entrypoint can create all three databases

### Requirement: rails depends on a healthy postgres

The `rails` service SHALL declare `depends_on` the `postgres` service with a `service_healthy` condition, so Rails (and its DB create/migrate at entrypoint) does not start until PostgreSQL is accepting connections.

#### Scenario: rails waits for postgres health

- **WHEN** the stack starts
- **THEN** `rails` does not start until the `postgres` healthcheck reports healthy

### Requirement: rails and jobs receive the Postgres connection coordinates

The `rails` and `jobs` services SHALL receive the database connection coordinates so the rails entrypoint can connect to PostgreSQL to run `db:prepare`. The coordinates SHALL use the `DATABASE_HOST`/`DATABASE_USER` style: `DATABASE_HOST=postgres` (the compose service name, resolved over compose DNS) and `DATABASE_USER=postgres` (the connect-as superuser that holds CREATE-DATABASE privilege). Because the `postgres` service uses `POSTGRES_HOST_AUTH_METHOD=trust`, no password is required and none SHALL be configured. The matching database config (the three-database primary/queue/cable layout) is owned by `rails-foundation`; this change supplies the host/user coordinates that point it at the `postgres` service.

#### Scenario: rails connects to postgres on first boot

- **WHEN** the `rails` container starts on first boot and its entrypoint runs `db:prepare`
- **THEN** it connects to PostgreSQL using `DATABASE_HOST=postgres` and `DATABASE_USER=postgres` with no password (trust auth), so it can create and migrate all three databases

#### Scenario: jobs receives the same connection coordinates

- **WHEN** the `jobs` service starts
- **THEN** it receives the same `DATABASE_HOST=postgres` and `DATABASE_USER=postgres` coordinates so the Solid Queue supervisor connects to the same database as `rails`

### Requirement: Source bind-mounted delegated; dependencies in named volumes

Each service SHALL bind-mount its source tree into the container with the `:delegated` consistency option so host edits are reflected live. Installed dependencies SHALL live in **named volumes** rather than host bind mounts: gems in a `bundle` named volume, `node_modules` for the sidecar and the web/vite services in named volumes, and PostgreSQL data in its named volume. The compose file SHALL NOT bind-mount `node_modules` or the gem directory from the host.

#### Scenario: Host source edits are visible in the container

- **WHEN** a developer edits a source file on the host
- **THEN** the change is visible inside the running service because the source is bind-mounted `:delegated`

#### Scenario: Dependencies do not pollute the host tree

- **WHEN** dependencies are installed
- **THEN** gems and `node_modules` are written to named volumes, not into the host-mounted source tree

### Requirement: vite service enables file-watch polling for HMR over the bind mount

The `vite` service SHALL set the file-watch polling environment variable `VITE_USE_POLLING=true` so that Vite uses polling rather than native inotify file-system events. Native FS events do not propagate reliably across the macOS `:delegated` bind mount, so without polling, HMR would not detect host edits. `web-scaffold` consumes `VITE_USE_POLLING` to gate its watcher config; this change SHALL set it on the `vite` service (the name `VITE_USE_POLLING` is coordinated with `web-scaffold`).

#### Scenario: HMR works over the macOS bind mount

- **WHEN** the `vite` service starts
- **THEN** it has `VITE_USE_POLLING=true` set, so Vite polls for file changes and HMR detects host edits made over the `:delegated` bind mount

### Requirement: Dev services select the development environment explicitly

The dev services SHALL set an explicit environment selector so the documented dev-vs-production serving branch (owned by `rails-dev-serving`) has something to switch on. The `rails` and `jobs` services SHALL set `RAILS_ENV=development`, and the `sidecar` and `vite` node services SHALL set `NODE_ENV=development`. Without an explicit selector, the dev-vs-prod serving branch has no env var to choose between modes.

#### Scenario: Every service declares its environment

- **WHEN** the compose file is inspected
- **THEN** `rails` and `jobs` set `RAILS_ENV=development` and the `sidecar` and `vite` services set `NODE_ENV=development`, so the dev-vs-prod serving branch has an explicit selector

### Requirement: Minimal one-process-per-service stack

The compose stack SHALL follow a one-container-per-process pattern (single entry script, bind-mounted source `:delegated`, named volumes for deps + DB data, one process per service) and SHALL include only the five services clawdparty requires. It SHALL NOT add services this MVP does not use (search index, Redis, mail catcher, extra apps) or an HTTPS/reverse-proxy-TLS mode.

#### Scenario: Only clawdparty's five services are present

- **WHEN** the compose file is inspected
- **THEN** it defines only `rails`, `jobs`, `postgres`, `sidecar`, and `vite` — no extra services
