## Context

`docs/PLAN.md §2` makes the local-dev runtime a **final decision**: Docker Compose, one container per process, `bin/start` as the single entry point, source bind-mounted (`:delegated`), deps in named volumes. This change is the first thing built in Week 1 (`§10`, ~0.5d) because **every other stream develops inside it**: `rails-foundation`, `sidecar-foundation`, and `web-scaffold` all run as services in this compose stack and assume it exists.

The architecture has three decoupled-lifecycle invariants that the container topology must honor exactly (`CLAUDE.md`, `docs/PLAN.md §2/§3/§9`):
1. **Only `rails` is reachable from the LAN.** Puma binds `0.0.0.0:3000` *inside* the container and that is the one published port. `sidecar` (`:8787`) and `vite` (`:5173`) are unpublished — the Docker equivalent of loopback-only. Nothing assumes a fixed host (`SIDECAR_URL` is configurable) so Tailscale is a future drop-in.
2. **The `sidecar` is NOT a child of `rails`.** It is its own service with its own restart policy; a Rails restart must not kill a Claude run.
3. **Claude auth is the host developer's existing login, mounted read-only.** The sidecar owns no credential; it inherits host auth env and read-only-mounts `~/.claude` + `~/.aws`.

The **pattern** is a standard one-container-per-process Compose dev stack (single `bin/start`, bind-mounted source `:delegated`, named volumes for `bundle`/`node_modules`/`pg_data`, one service per process, `${HOME}/.aws` mounted, postgres healthcheck, entrypoints that `bundle check || bundle install` and `wait-for-it postgres`). clawdparty keeps only the five services it needs and deliberately omits anything an MVP doesn't use (a search index, Redis, a mail catcher, extra apps, an HTTPS/TLS mode, worktree volume-cloning).

Toolchain pins (`docs/PLAN.md §2` + the scope brief): **Ruby 4.0.5**, **Node 24** (the host runs Node 25 — pin 24 in images to avoid drift, matching the `sidecar-foundation` CI decision), **PostgreSQL 18**.

## Goals / Non-Goals

**Goals:**
- One command (`bin/start`) builds and boots the whole stack; `bin/setup` generates `SIDECAR_SHARED_SECRET` and prepares the env once.
- Five services, **one process each**: `rails`, `jobs`, `postgres`, `sidecar`, `vite` — with `depends_on`/healthchecks and named volumes for deps + postgres data, source bind-mounted `:delegated`.
- `rails` is the only service publishing a port (`3000:3000`); `sidecar`/`vite` unpublished; `rails` reaches the sidecar at `http://sidecar:8787` via compose DNS (`SIDECAR_URL`).
- The `sidecar` read-only mounts host `~/.claude` + `~/.aws` (credentials only); the target repo is bind-mounted **read-write** (Claude edits the worktree; reject reverts it). It inherits the host Claude/AWS auth env (auth-method-agnostic); the two host caveats are documented.
- The target repo is bind-mounted at a **consistent absolute path** in both `rails` and `sidecar` so git-worktree absolute `.git` paths resolve in both.
- The `sidecar` has its own restart policy; the `~/.claude` mount makes the Claude session JSONL survive container restarts for `claude_session_id` resume.
- Pin Ruby 4.0.5 / Node 24 / PostgreSQL 18 in the images.

**Non-Goals:**
- Any Rails/sidecar/web **application code** — owned by `rails-foundation`, `sidecar-foundation`, `web-scaffold`. This change only provides the runtime they run in.
- HTTPS / OrbStack-DNS mode, monitoring/observability, Docker CI runners (the per-stream CI jobs live in those changes), worktree namespacing for parallel stacks, and any services beyond the five clawdparty needs.
- Remote access (Tailscale) — future phase; the design only keeps it a drop-in (no fixed-host assumptions).
- The *contents* of the sidecar's auth precedence logic — the sidecar owns "no credential in code" (`sidecar-foundation`'s `claude-auth-passthrough`); this change owns the **mount + env wiring** that feeds it.

## Decisions

**1. Five services, one process per container; `rails` and `jobs` share one image.**
`rails` (Puma), `jobs` (`bin/jobs` Solid Queue supervisor), `postgres`, `sidecar`, `vite`. `jobs` reuses the `rails` image with a different command — same code, different process — the standard pattern of one image driving several process-specialized services. *Why:* `docs/PLAN.md §3` topology is exactly these processes; one-process-per-container is what makes the decoupled-lifecycle invariants (sidecar independence, jobs separate from web) physical rather than aspirational. *Alternative rejected:* a single all-in-one container — collapses the lifecycle boundaries the whole architecture depends on.

**2. Only `rails` publishes a port (`3000:3000`); `sidecar` and `vite` are unpublished.**
`sidecar` (`8787`) and `vite` (`5173`) expose ports only on the compose network, never to the host/LAN. *Why:* `docs/PLAN.md §2/§9` — "not publishing a service's port is the Docker equivalent of loopback-only." Rails reaches the sidecar at `http://sidecar:8787` (compose DNS), set via `SIDECAR_URL` so no host is hard-coded; `vite` proxies `/api` + `/~cable` to `rails` over the same network. *Alternative rejected:* publishing `8787`/`5173` for host curl-debugging — breaks the security perimeter; the sidecar is curl-debuggable from *inside* the network instead (`docs/PLAN.md §2`).

**3. Puma binds `0.0.0.0:3000` INSIDE the container.**
The bind is `0.0.0.0` *within* the container (so the published port reaches it); the LAN exposure comes solely from the single `3000:3000` publish on the `rails` service. *Why:* this is the one place the architecture intentionally reaches the LAN (`docs/PLAN.md §3` "the ONLY published port (→ LAN)"); `config.hosts`/cable-origins live in the Rails app (`rails-foundation`/§10 W3), not here. *Note:* the actual `0.0.0.0` bind is in the `rails` Dockerfile `CMD`/entrypoint this change owns (`bin/rails s -b 0.0.0.0 -p 3000`).

**4. Target repo bind-mounted at a CONSISTENT absolute path in both `rails` and `sidecar`.**
Git worktrees record **absolute** `.git` paths. Rails creates worktrees at `<repo>/.clawdparty/worktrees/session-<id>`; the sidecar uses each as `cwd`. If the repo were mounted at different in-container paths, the worktree's recorded absolute gitdir would be invalid in the sidecar. *Decision:* both services mount the target repo at the **same** container path — pinned to the single constant `/repo` — with the host path parameterized by an env var (`TARGET_REPO_PATH`) so the host path is configurable while the in-container path is identical (`/repo`) across services. *Why:* this is a silent-corruption gotcha — a mismatch produces "not a git repository" / dangling-gitdir errors at run time, not build time. *Alternative rejected:* mounting only into the sidecar — Rails needs the same path to *create* the worktree the sidecar then uses.

**5. Source bind-mounted `:delegated`; deps in named volumes.**
Each service bind-mounts its source tree `:delegated` (host edits reflect live for hot-reload). Gems (`bundle`), `node_modules` (sidecar + web), and postgres data (`pg_data`) live in **named volumes**, not host bind mounts. *Why:* `docs/PLAN.md §2` ("source bind-mounted `:delegated`, deps in named volumes"). Named volumes keep platform-specific installed deps out of the host tree (no host pollution, no Linux/macOS binary clashes) and survive `docker compose up` cycles; postgres data in a named volume persists across restarts. *Alternative rejected:* bind-mounting `node_modules`/`bundle` from the host — slow on macOS and cross-platform-fragile.

**6. `bin/start` = single entry point; `bin/setup` = one-time secret/env prep.**
`bin/start` runs `docker compose build` then `docker compose up` (sensible flags: `--remove-orphans`; build-first to avoid a first-run "pull access denied"). `bin/setup` generates a random `SIDECAR_SHARED_SECRET` and writes the env file (idempotent — does not clobber an existing secret). *Why:* `docs/PLAN.md §4/§10` name both scripts; one command to run the stack is the whole point. DB **creation** is deferred to the `rails` container entrypoint (Decision 8), not `bin/setup`, because the DB lives in postgres-the-container — `bin/setup` runs on the host before any container exists. *Alternative rejected:* `bin/setup` creating DBs directly — it has no postgres to talk to yet.

**7. Dockerfiles pin Ruby 4.0.5 / Node 24 / PostgreSQL 18; entrypoints install deps + wait-for-postgres.**
`docker/` holds a Dockerfile per image: a Ruby 4.0.5 image for `rails`/`jobs`, a Node 24 image for `sidecar`, a Node 24 image for `web` (vite). `postgres` uses the official `postgres:18` image directly (no custom Dockerfile needed). Entrypoints follow the standard pattern: the rails entrypoint does `bundle check || bundle install` then `wait-for-it postgres:5432` then DB create/migrate; the node entrypoints do `yarn install`/`npm install` against the named-volume `node_modules`. *Why:* pinned base images give a reproducible toolchain (`docs/PLAN.md §2` rationale); entrypoint-time install (vs bake-time) is what lets bind-mounted source + named-volume deps coexist and self-heal on lockfile drift. *Trade-off:* first boot is slower (install runs in-container) — accepted.

*Sidecar container user (load-bearing for credential resolution):* the `node:24` base image ships a **non-root `node` user** (home `/home/node`), whereas the default for an unspecified `USER` is `root` (home `/root`). The SDK resolves file-based creds via `~`, so **which user the sidecar process runs as determines where `~/.claude`/`~/.aws` must be mounted** — get this wrong and the SDK silently finds no creds. *Decision:* the sidecar runs as the **non-root `node` user** (the `node:24` base image's default non-root user) — least privilege is the better default — so `$CONTAINER_HOME` = `/home/node` and the credential mounts target `/home/node/.claude` and `/home/node/.aws`. We pin this `USER node` explicitly in the sidecar Dockerfile (this change MUST not leave it implicit) and derive the container-side home as `$CONTAINER_HOME` = `/home/node`. Decision 9's mounts target `$CONTAINER_HOME/.claude` and `$CONTAINER_HOME/.aws` accordingly, so `~` resolution is deterministic. The general rule still holds (the home must match whatever user the process runs as — `/root` for `root`, `/home/node` for `node`), but the chosen user is `node`. The Ruby `rails`/`jobs` image runs as root (no Claude creds mounted there — Decision 9 / task 7.5), so this `$CONTAINER_HOME` concern applies only to the `sidecar`.

**8. DB creation/migration happens in the `rails` container entrypoint, gated on postgres health.**
`rails` `depends_on: postgres: condition: service_healthy`; postgres has a `pg_isready` healthcheck. The rails entrypoint `wait-for-it postgres:5432` then `db:prepare` (create + migrate the primary/queue/cable DBs `rails-foundation` defines). *Why:* the three-DB Solid Queue/Cable setup is `rails-foundation`'s schema, but it can only run once postgres is healthy and the app code is mounted; the entrypoint is the right seam and keeps `bin/setup` host-only. *Note:* this change provides the *hook* (entrypoint + healthcheck-gated `depends_on`); the migrations themselves are `rails-foundation`'s.

**9. Claude auth: read-only mounts `~/.claude` + `~/.aws` into the `sidecar`, pass through host auth env only-when-set.**
The `sidecar` service mounts `${HOME}/.claude:$CONTAINER_HOME/.claude:ro` and `${HOME}/.aws:$CONTAINER_HOME/.aws:ro` and passes through `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `AWS_PROFILE`, `AWS_REGION`, `ANTHROPIC_MODEL` — **pass-through only when set** (compose `KEY:` / `${KEY:-}` form, so an unset var is not forced to empty and the SDK's own precedence/auto-detect is preserved). Because the sidecar runs as the non-root `node` user (Decision 7), `$CONTAINER_HOME` = `/home/node`, so the mounts target `/home/node/.claude` and `/home/node/.aws` — **never a hardcoded `/root`**, because the SDK resolves `~` to `/home/node` for the `node` user and a `/root` mount would silently miss. The container-side mount path tracks the sidecar user's home (`/home/node`) so `~/.claude` always resolves to the mounted creds. *Why:* `docs/PLAN.md §2` (Claude-auth row) + `§9` — the sidecar uses whatever login the dev already has (API key | subscription/enterprise OAuth | Bedrock), auth-method-agnostic, with no app-owned key. The SDK auto-detects; we must not narrow or reorder its choice. *This change owns the wiring* (the mounts + env list); `sidecar-foundation`'s `claude-auth-passthrough` owns the complementary "no credential in code" rule. *Alternative rejected:* baking a key into the image or `.env` — violates the no-app-owned-credential invariant. *Alternative rejected:* hardcoding `/root` regardless of user — breaks `~` resolution the moment the sidecar runs as `node`.

**10. Mounts are READ-ONLY (tamper-safety); the `~/.claude` mount doubles as the resume path.**
`~/.claude` and `~/.aws` are mounted `:ro` so a Claude run cannot write/tamper with the host's login state (`docs/PLAN.md §9`). The same `~/.claude` mount means the Claude session JSONL in `~/.claude/projects/` lives on the host and **survives container restarts**, so after a sidecar restart the host can resume via `claude_session_id` (`docs/PLAN.md §7` crash recovery). *Why:* read-only is a security guarantee *and* the durable-resume mechanism in one mount. *Documented caveats (host responsibilities, not solvable in this change):* (a) macOS subscription/enterprise OAuth is in the **Keychain (no file)** → invisible to the Linux container → the dev runs `claude setup-token` once and exports `CLAUDE_CODE_OAUTH_TOKEN`; (b) Bedrock-via-SSO tokens **expire** → the host must stay `aws sso login`-fresh (the read-only mount reflects the refreshed token; the container can't refresh itself).

**11. `sidecar` has its own restart policy and is not a `depends_on` child of `rails`.**
`sidecar` gets `restart: unless-stopped` (or equivalent) independent of `rails`. It may `depends_on` nothing app-critical (it talks to `rails` over HTTP and ring-buffers when Rails is down, per `sidecar-foundation`). *Why:* `docs/PLAN.md §2` "NOT a child of Rails" + `§7` crash recovery — Rails restarts must not kill Claude runs; the container restart loop is what reboots a dead sidecar. *Alternative rejected:* `sidecar` `depends_on: rails` — would couple their lifecycles, the exact thing the architecture forbids.

**12. `vite` is dev-only and unpublished; `rails` reverse-proxies the SPA + HMR to it.**
The `vite` service (Node 24, `:5173` unpublished) runs the dev server. In the **primary** dev path, `rails` reverse-proxies all SPA requests and the HMR WebSocket to the unpublished `vite` service over the compose network, so the single published `rails:3000` port is the only way the browser reaches the app (consistent with the compose-networking "rails fronts both API and the dev SPA" requirement). The Vite-side proxy of `/api` + `/~cable` back to `rails` is only the **secondary** convenience for running Vite directly on the host, not the normal flow. In production-style serving, the built SPA is served by `rails` directly (so `vite` is not needed) — hence dev-only. *Why:* `docs/PLAN.md §3` ("[dev only, container: vite]") and `§16` (the standard Vite WS proxy pattern). The actual Vite config is `web-scaffold`'s; this change provides the service + unpublished port + network reachability.

**13. `.dockerignore` excludes `.git`, `node_modules`, `vendor/bundle`, logs, `tmp`, build artifacts, and `.env.local`.**
*Why:* keeps build context small/fast and prevents host-installed deps (wrong-platform binaries) or VCS metadata from leaking into images. Listing `.env.local` (the git-ignored file `bin/setup` writes the generated `SIDECAR_SHARED_SECRET` into) keeps the secret out of any image layer (e.g. a `COPY . .` cannot bake it in). Standard hygiene.

## Risks / Trade-offs

- **Worktree path mismatch between `rails` and `sidecar` → silent git corruption at run time.** → Mount the target repo at the *same* container path in both services (Decision 4); make it a hard requirement with a scenario, since the failure is a confusing runtime error, not a build error.
- **macOS Keychain OAuth invisible to the Linux container.** → Cannot be fixed in compose (the credential isn't a file). Document the `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` workaround as a host responsibility in the runbook (Decision 10).
- **Bedrock-via-SSO token expiry inside a long-lived container.** → The read-only mount reflects host refreshes, but the container can't `aws sso login` itself. Document "host stays `aws sso login`-fresh" (Decision 10).
- **First boot is slow (entrypoint-time `bundle install` / `yarn install`).** → Accepted. Named volumes make subsequent boots fast (install only the lockfile diff).
- **Host on Node 25 vs images on Node 24.** → Pin Node 24 in images (and CI in the sibling changes) so the validated runtime is deterministic; accepted minor gap, documented.
- **Read-only `~/.aws`/`~/.claude` could surprise a dev expecting the container to log in.** → Intentional (tamper-safety); the runbook states the host owns login and the container only reads it.
- **`bin/setup` re-run could regenerate the secret and break a running stack.** → `bin/setup` is idempotent: it generates `SIDECAR_SHARED_SECRET` only if absent, never clobbering an existing one.
- **[Risk] Publishing 3000 to the LAN without config.hosts/cable-origins set in rails-foundation → Rails HostAuthorization silently blocks `<host>.local`.** → Mitigation: rails-foundation owns config.hosts + cable allowed origins for `.local`/LAN-IP; track this as a cross-change dependency so it isn't lost between change sets.
- **[Risk] mDNS `.local` is resolved by the HOST, not from inside Linux containers on Docker for Mac.** → Inter-container traffic uses compose DNS (e.g. `http://sidecar:8787`), which is fine; only LAN clients resolve `<host>.local` via host mDNS. Nothing inside a container should depend on resolving a `.local` name.

## Migration Plan

Greenfield — no migration. Rollout is purely additive: new `docker-compose.yml`, `docker/`, `bin/start`, `bin/setup`, `.dockerignore`, and an env template. A developer runs `bin/setup` once (generates the secret + env), then `bin/start` to build and boot. The sibling changes' application code drops into the bind-mounted service directories and is picked up on the next `bin/start`. Rollback is deleting the compose files and `bin` scripts; nothing persists outside the named volumes (which can be `docker volume rm`'d).

## Open Questions

- None.

## Resolved (previously open)

- **In-container target-repo path constant** → Pinned to `/repo`. The in-container mount path is the single constant `/repo`, identical across `rails` + `sidecar` (so absolute worktree gitdir paths resolve in both); only the host path stays configurable (via `TARGET_REPO_PATH`). Pinning it now removes the cross-service coordination round-trip — a mismatch would otherwise silently corrupt worktrees at run time. The *consistency* remains the binding requirement; `/repo` is the chosen value.

- **Whether `jobs` needs the `~/.claude`/`~/.aws` mounts** → No. `Sidecar::HealthcheckJob` only marks stale runs failed and makes no SDK call, so only `sidecar` mounts Claude credentials. Confirmed by task 7.5; revisit only if a future job calls the SDK.
