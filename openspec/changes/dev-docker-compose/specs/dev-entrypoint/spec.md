## ADDED Requirements

### Requirement: bin/start is the single entry point

`bin/start` SHALL be the one command a developer runs to bring up the entire stack. It SHALL build the images (`docker compose build`) and then start the services (`docker compose up`) with sensible flags (including `--remove-orphans`), building before up so the first run does not fail on a missing/unpulled image. No other command should be required to run the stack.

#### Scenario: A developer boots the whole stack with one command

- **WHEN** a developer runs `bin/start`
- **THEN** the images are built and all services come up, with no other command required

#### Scenario: First run builds before up

- **WHEN** `bin/start` runs on a machine that has never built the images
- **THEN** it builds the images first and then starts the services, so the up step does not fail on a missing image

### Requirement: bin/setup generates the shared secret and prepares the env

`bin/setup` SHALL generate a random `SIDECAR_SHARED_SECRET` — the bearer secret shared between Rails and the sidecar — and write it into the local env file the stack reads (`.env.local`; a committed `.env.example` documents the slots). `bin/setup` SHALL be idempotent: it SHALL generate the secret only if one is not already present and SHALL NOT overwrite an existing `SIDECAR_SHARED_SECRET`. `bin/setup` SHALL NOT attempt to create databases directly, because it runs on the host before any container exists. The local env file holding the generated secret (`.env.local`) SHALL be git-ignored AND listed in `.dockerignore`, so the secret never enters version control or an image layer (e.g. a `COPY . .` cannot bake it into an image).

#### Scenario: First setup generates a secret

- **WHEN** a developer runs `bin/setup` and no `SIDECAR_SHARED_SECRET` exists yet
- **THEN** a random `SIDECAR_SHARED_SECRET` is generated and written to the env file

#### Scenario: Re-running setup does not clobber the secret

- **WHEN** a developer runs `bin/setup` again and a `SIDECAR_SHARED_SECRET` already exists
- **THEN** the existing secret is preserved and not regenerated

#### Scenario: The generated secret never enters VCS or an image layer

- **WHEN** bin/setup writes SIDECAR_SHARED_SECRET to its env file
- **THEN** that env file is git-ignored and listed in .dockerignore so no COPY bakes it into an image

#### Scenario: Database creation is not bin/setup's job

- **WHEN** `bin/setup` runs on the host
- **THEN** it does not create databases directly, leaving DB creation to the rails container entrypoint

### Requirement: Both rails and sidecar receive SIDECAR_SHARED_SECRET from the same .env.local

`bin/setup` writes `SIDECAR_SHARED_SECRET` into `.env.local`, and the compose file SHALL load `.env.local` and SHALL inject `SIDECAR_SHARED_SECRET` into **both** the `rails` and `sidecar` service environments from that single source, so both sides hold the identical value (otherwise the `/internal/events` bearer authentication between sidecar and Rails fails). Because Docker Compose does NOT auto-load `.env.local` the way it auto-loads a root `.env`, `.env.local` SHALL be referenced explicitly — via `env_file: .env.local` on the `rails` and `sidecar` services, or an equivalent mechanism — rather than relying on implicit loading.

#### Scenario: Both services see the same SIDECAR_SHARED_SECRET value

- **WHEN** the stack is up after `bin/setup` has written `SIDECAR_SHARED_SECRET` to `.env.local`
- **THEN** both the `rails` and `sidecar` services receive that identical `SIDECAR_SHARED_SECRET` value from the single `.env.local` source, so the `/internal/events` bearer auth succeeds

#### Scenario: .env.local is loaded explicitly, not implicitly

- **WHEN** the compose file is inspected
- **THEN** `.env.local` is referenced explicitly (e.g. via `env_file: .env.local` on the `rails` and `sidecar` services) because Compose does not auto-load `.env.local` the way it auto-loads a root `.env`

### Requirement: bin/setup ensures the host credential directories exist

`bin/setup` SHALL ensure the host `~/.claude` and `~/.aws` directories exist, creating them as empty directories if absent. This prevents Docker from silently creating a missing bind-mount source as an empty, often root-owned directory on first `bin/start`, which would surprise a developer who authenticates only via an environment-variable API key and never ran `claude` login on the host. Ensuring the directories exist as the host user keeps the bind-mount source owned by the developer and lets the env-var auth path fall through cleanly when the directories are empty.

#### Scenario: Missing credential directories are created by bin/setup

- **WHEN** a developer runs `bin/setup` on a host that has no `~/.claude` or `~/.aws`
- **THEN** `bin/setup` creates them as empty host-owned directories, so the later bind-mount source is not silently created root-owned by Docker

#### Scenario: API-key-only developer is not broken by empty credential dirs

- **WHEN** a developer who authenticates only via an environment-variable API key (and never ran `claude` login) runs `bin/setup` then `bin/start`
- **THEN** the empty `~/.claude` and `~/.aws` mounts do not break anything and auth still succeeds via the environment-variable path

### Requirement: Database creation happens in the rails container entrypoint, gated on postgres health

Database creation and migration SHALL happen in the `rails` service entrypoint, after the entrypoint waits for PostgreSQL to be reachable. This change SHALL provide the entrypoint hook and the healthcheck-gated `depends_on`; the migrations and schema themselves are owned by the `rails-foundation` change. The entrypoint's DB-prepare step SHALL create and migrate **all three logical databases** — primary, Solid Queue, and Solid Cable — e.g. via `db:prepare` across the three-database config, so first boot does not fail with only the primary database created. The PostgreSQL role/user the app connects as (the dev postgres superuser/role) SHALL have privilege to create those databases; otherwise first boot fails when `db:prepare` cannot create the queue and cable databases.

#### Scenario: DB prepare runs once postgres is reachable

- **WHEN** the `rails` container starts
- **THEN** its entrypoint waits for PostgreSQL to accept connections and then prepares the databases

#### Scenario: All three logical databases are created on first boot

- **WHEN** the rails entrypoint runs DB prepare on first boot
- **THEN** all three databases (primary, Solid Queue, Solid Cable) are created and migrated, using a postgres role that has privilege to create them

### Requirement: Per-service Dockerfiles pin the toolchain

The `docker/` directory SHALL contain a Dockerfile per image: a Ruby **4.0.5** image used by `rails` and `jobs`, a Node **24** image for the `sidecar`, and a Node **24** image for the web/`vite` service. The `postgres` service SHALL use the official **PostgreSQL 18** image. Node SHALL be pinned to 24 even though the host runs Node 25, to avoid drift between the dev/CI runtime and the host.

#### Scenario: Images pin the required toolchain versions

- **WHEN** the images are built
- **THEN** the Ruby image is Ruby 4.0.5, the sidecar and web images are Node 24, and postgres is PostgreSQL 18

#### Scenario: Node pinned to 24 despite host Node 25

- **WHEN** the sidecar/web images are built on a host running Node 25
- **THEN** the images still use Node 24 so the containerized runtime is deterministic

### Requirement: Entrypoints install dependencies and wait for postgres where relevant

Each service entrypoint SHALL install its dependencies against the named-volume dependency directories on boot (the rails entrypoint via `bundle check || bundle install`; the node entrypoints via the appropriate install). The `rails` entrypoint SHALL wait for PostgreSQL to be reachable before running DB tasks. Entrypoints SHALL self-heal on lockfile drift by installing only the difference.

#### Scenario: Rails entrypoint installs gems and waits for postgres

- **WHEN** the `rails` container starts
- **THEN** the entrypoint ensures gems are installed and waits for PostgreSQL before continuing

#### Scenario: Node entrypoints install node_modules

- **WHEN** the `sidecar` or web/`vite` container starts
- **THEN** its entrypoint installs `node_modules` into the named volume before starting the process

### Requirement: .dockerignore excludes VCS, deps, and build artifacts

A `.dockerignore` SHALL exclude `.git`, `node_modules`, `vendor/bundle` (the gem directory), logs, `tmp`, build artifacts, and the local secret env file (`.env.local`) from the Docker build context, so host-installed dependencies, VCS metadata, and the generated secret do not leak into images and the build context stays small.

#### Scenario: Build context excludes deps and VCS metadata

- **WHEN** an image is built
- **THEN** `.git`, `node_modules`, `vendor/bundle`, logs, `tmp`, and build artifacts are not sent to the build context
