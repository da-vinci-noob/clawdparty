# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

**clawdparty** is a real-time collaborative Claude Code session server: any number of developers join a browser session and watch/guide Claude Code working live on a repository hosted on one Mac. It provides shared chat, a live Claude activity stream, file/diff/terminal viewers, and a human approval flow for Claude's changes. The host machine runs everything (Rails + harness + repo); **everyone — including the host — interacts only through the browser.** The web session IS the interface to Claude; nobody drives it from a terminal.

**Current state: the MVP is implemented and merged to `main`.** The `api/`, `harness/`, `web/`, `packages/`, `docker/`, and `docs/contracts/` directories described below are real and working. The whole core loop ships — session create/join, chat, the live activity stream, interrupt, and diff review + approve (commit) / reject (revert) — plus the supporting features: no-git chat mode, the directory picker + per-repo review worktrees, and live-streaming text/thinking. **`docs/PLAN.md` is the authoritative design** and `docs/contracts/` holds the frozen interface contracts; the per-capability **living spec is under `openspec/specs/`** (promoted from the changes now archived in `openspec/changes/archive/`). When this file and the plan disagree, the plan wins (and fix this file).

## Architecture at a glance

Local dev runs as **four containers plus one HOST process** (`bin/start` brings up both and reports the health of each; `bin/stop` takes both down). Plus N browsers on the same LAN. The containerized processes are one compose service each; source is bind-mounted, deps live in named volumes.

```text
[container: rails]   Rails 8 API + ActionCable (Puma :3000 — the ONLY published port → LAN; serves the built SPA)
[container: jobs]    Solid Queue supervisor (bin/jobs)        — jobs are short; long work lives in the harness
[container: postgres] PostgreSQL 18 (primary + queue + cable DBs)  — data in a named volume
[HOST PROCESS: harness] Node Fastify on 127.0.0.1:8787 — NOT a container ; `bin/harness start|stop|status`
  └── OWNS the agent loop: Messages API + provider adapters behind one contract
  └── per-session SQLite record (the authority); Postgres `events` is a projection of it
  └── on the host, so it needs NO mounts: it reaches any project directly, resolves symlinks that leave a
      project (pnpm store, npm link), sees the host toolchain + SSH agent, and reads credential locations a
      container cannot — notably the macOS Keychain
  └── reads the dev's EXISTING login in place (API key | subscription/enterprise OAuth | Bedrock),
      auth-method-agnostic; the app owns no credential
  └── EVERY control route requires a bearer HARNESS_SHARED_SECRET, /healthz included — see the bindings
      invariant below for why loopback is not the boundary
  └── supervised by launchd/systemd (docker/launchd, docker/systemd) so it restarts on crash and starts at login
[dev only, container: vite] Vite :5173 (UNPUBLISHED). Dev request flow: the browser hits rails:3000 only; Rails serves /api + /~cable and reverse-proxies SPA + Vite HMR ws to the vite container (in prod Rails serves the built SPA). Vite sets server.host:true + hmr.clientPort:3000 so HMR survives the proxy hop.
Rails reaches the harness at http://host.docker.internal:8787 (via extra_hosts:host-gateway; configurable via HARNESS_URL). On LINUX the docker bridge does NOT proxy host loopback — set HARNESS_BIND_HOST to the bridge gateway there.
Git worktrees (bind-mounted): <REPO_ROOT>/.clawdparty/worktrees/session-<id>  (branch clawd/session-<id>, created FROM the session's picked repo)
The target dir (TARGET_REPO_PATH, the PARENT of your repos) is mounted at the IDENTICAL host path in-container (host path == container path), and REPO_ROOT = that path. Identical paths are load-bearing: git worktree metadata stores ABSOLUTE gitdir paths, so a worktree created in the container is only valid on the host (GitHub Desktop / host git worktree) when the two paths match.
```

The three code streams and **who owns which file** (operate in the stream that owns the file — do not put Rails logic in the harness or vice-versa):

- **`api/`** — Rails 8 API + ActionCable. Models/migrations, `Events::Ingest`, `Runs::*` services, `SessionPolicy`, `RepoBrowser`, `Git::*` (worktree/diff/changeset), channels, controllers. Talks to the harness over HTTP; imports no provider SDK at all.
- **`harness/`** — Node + Fastify. **Owns the agent loop, the record, and recovery.** Files: `index.ts` (server + heartbeat), `supervisor.ts` (live runs; ONE store per session, shared by lanes), `loop/` (`run_loop` · `request_builder` · `checkpoint` · `stop_reasons` · `normalize` — the last is the only file mapping `ProviderEvent` to Contract-1, and unknown shapes become `ai_raw`, never a crash), `store/` (SQLite/WAL record + the total position marker), `providers/` (**each adapter is the only code that may import its vendor SDK**), `tools/`, `extensions/` (the four points; `tool:before` is the command gate), `transport.ts` (batched/idempotent POST + `store_seq`).
  <!-- doc-truth:ignore -->
  `runner.ts`, the SDK-era `normalizer.ts` and `permissions.ts` are **deleted** — the last because a seam that cannot intercept must not exist. (Fenced: these are named to say they are GONE, so doc-truth must read them as a quotation rather than a claim.)
  <!-- doc-truth:end -->
- **`web/`** — React 19 + Vite + TypeScript + Tailwind SPA. State: **Zustand** (event streams) + **TanStack Query** (fetched resources). Key libs: `react-diff-view`, `react-arborist`, `shiki`, `@dnd-kit`, `anser`, `@rails/actioncable`. The catch-up/cable logic lives in one file: `web/src/lib/cable.ts`.

## Repo layout (target — per the plan)

```text
clawdparty/
├── docs/PLAN.md             # authoritative design doc (read this first)
├── docs/contracts/          # frozen interface contracts: events.md, harness_protocol.md, http_api.md, CHANGELOG.md
├── packages/contracts/      # shared TS types + fixtures/sample_run.jsonl (the executable contract)
├── api/                     # Rails 8 API + ActionCable + PostgreSQL
├── harness/                 # Node; owns the loop, the record, recovery
├── web/                     # React 19 + Vite + TS + Tailwind
├── docker/                  # Dockerfiles + entrypoints per service (rails, harness, web)
├── docker-compose.yml       # rails · harness · jobs · postgres (+ vite in dev); named volumes
├── bin/start                # brings up the containers AND the host harness; reports both
├── bin/stop                 # takes both down; harness first, so it releases its store locks
├── bin/harness              # start|stop|status|logs|foreground + sessions|reset-session for the host process
├── bin/setup                # generates HARNESS_SHARED_SECRET + prepares env (DB creation runs in the rails container entrypoint)
├── .claude/ + openspec/     # OpenSpec workflow wiring (see below)
```

## The contracts are load-bearing — freeze before building features

Three contracts (`docs/contracts/` + `packages/contracts/`) are the seams that let the three streams build independently. Once frozen, post-freeze changes need sign-off from all contributors + a `CHANGELOG.md` entry; additive event types are cheap, envelope changes are emergencies.

1. **Event taxonomy + envelope** — every live thing arrives as one event: `{ id, session_id, ai_run_id, seq, type, actor, ts, payload }`. 20 types (+ the `ai_raw` fallback for unmapped SDK messages): `run_started`, `ai_text_delta`, `ai_text`, `ai_thinking`, `tool_started`/`tool_finished`/`tool_failed`, `terminal_output`, `file_changed`, `run_finished`/`run_failed`/`run_interrupted`, `changeset_ready`/`changeset_approved`/`changeset_rejected`, `chat_message`, `task_created`/`task_updated`, `participant_joined`, `presence_changed`. **Keep these names exact** — the normalizer emits them, Rails persists them, the web reducer switches on them.
2. **Rails ↔ harness protocol** — the A↔B seam, including the worktree convention (Rails creates it; path/branch layout above; `base_sha` recorded at run start).
3. **REST + cable API** — endpoints + the role matrix. **Rule: everything live arrives as a Contract-1 event. No bespoke cable messages.**

`packages/contracts/fixtures/sample_run.jsonl` (GENERATED from a real harness run — `cd harness && npm run capture:fixture`; regeneration is byte-stable) is the **executable contract**: the web renders it, a Rails fake-Claude rake task replays it through real ingest, the harness's normalizer tests assert producing it.

## Invariants — easy to get wrong, expensive when wrong

- **One active run per session, enforced at the DB:** partial unique index on `ai_runs.session_id WHERE status IN ('queued', 'running', 'awaiting_review')` (quoted literals — `status` is a native PG enum / string, never integer-backed). `Runs::Start` also requires a clean worktree (except on revise).
- **Per-run monotonic `seq`; global `events.id` is the client cursor.** Unique index on `events [ai_run_id, seq]` makes ingest idempotent — duplicate `(run_id, seq)` is silently skipped, so retries/replays are safe.
- **Every mutation appends an event in the same transaction** (`Events::Append`). The event stream alone must be able to reconstruct the UI.
- **Two-tier streaming text:** `ai_text_delta` is **ephemeral — broadcast, never persisted** (coalesced ~150ms in `harness/src/transport.ts`); `ai_text` is the durable record emitted on block stop. `presence_changed` is also ephemeral. **Ephemeral delivery is single-flight — one POST in flight at a time, never fire-and-forget.** Ephemerals carry `seq: null`, so the client concatenates them in ARRIVAL order and has no key to re-sort by; concurrent POSTs scrambled the words of a sentence under ordinary latency variance. `test/transport_ephemeral_order.test.ts` guards it.
- **Reject severs the resumed context.** The rule is unchanged; only its carrier is — `claude_session_id` is gone, and Rails now sends `resume_context: false`, which the harness enforces as a surface BASELINE (the log is never deleted; the next request starts folding after it). After a reject (`git reset --hard HEAD && git clean -fd` in the worktree), the next run must NOT resume the old Claude session — its context believes reverted edits still exist. Only **revise** resumes the session (old run → `superseded`, dirty tree kept, cumulative diff reviewed as one changeset). This rule is encoded in `Runs::Start`.
- **Diffs go over REST, never cable** (`GET /api/runs/:id/diff`). Run finalize uses `git add --intent-to-add -A && git diff HEAD --numstat` so untracked files are counted.
- **Server enforces roles; the client only hides buttons.** `SessionPolicy` (PORO) gates every controller action; cable subscriptions independently verify participantship. Roles: `owner` (everything incl. invites/archive/bypass) > `editor` (runs/follow-ups/interrupt + approve/reject + tasks/chat) > `reviewer` (approve/reject + tasks/chat/view) > `viewer` (view/chat). **Approve/reject is owner+editor+reviewer** (everyone but viewer); driving Claude (run/follow-up/interrupt) is owner+editor; invites/archive/bypass are owner-only.
- **The terminal pane is a read-only replay of Claude's Bash events. There is no input path to a shell anywhere.** Do not add one.
- **Bindings are deliberate, and PLACEMENT IS NOT THE BOUNDARY.** Only the `rails` container **publishes** a port (`3000` → LAN). `vite` (`:5173`) is unpublished, compose-network only. The `harness` binds **host loopback** (`127.0.0.1:8787`), which is reachable by the containers *and by every other process running as the developer* — so **every harness control route authenticates with a bearer `HARNESS_SHARED_SECRET` under a constant-time compare, `/healthz` included**. It used to be a compose service, and the private network was the only thing between a caller and the control surface; that argument died with the host move, which is why the auth shipped BEFORE it. Nothing in the app may assume a fixed host: Rails reaches the harness via `HARNESS_URL` (default `http://host.docker.internal:8787`), and nothing assumes `localhost` for the browser side — that is what keeps Tailscale a future drop-in. Auth = role-scoped reusable invite links → signed httpOnly cookie (no `Secure` flag on plain-HTTP LAN); the cookie also authenticates ActionCable.
- **Late-joiner catch-up is gap-free and lives in `web/src/lib/cable.ts`:** subscribe to cable FIRST → buffer live events → REST backfill `GET /api/sessions/:id/events?after=<cursor>` → drain buffer applying only `id > maxBackfilledId` → live. Stores dedupe **durable** events by `event.id`; ephemeral events (`ai_text_delta`, `presence_changed`) have a null `id`, bypass backfill, and are not deduped by id (deltas accumulate by `(ai_run_id, block)`, presence is last-writer-wins).
- **File API safety (`RepoBrowser`):** tree from `git ls-files --cached --others --exclude-standard`; content reads use realpath-containment (defeat `../` and symlinks) + a denylist (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `*secret*`, `.git/`) + 1MB cap + null-byte binary detection.
- **Claude auth is the host's existing login — never a key the app owns.** The harness is **auth-method-agnostic**: it inherits whatever the host developer already has (direct API key, Claude subscription/enterprise OAuth, or Amazon Bedrock) via read-only bind mounts (`~/.claude`, `~/.aws`) + passed-through auth env (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`/`CLAUDE_CODE_USE_VERTEX`, `AWS_PROFILE`/`AWS_REGION`, `ANTHROPIC_MODEL`). The SDK auto-detects in its own precedence (cloud-provider flag → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `CLAUDE_CODE_OAUTH_TOKEN` → `~/.claude` creds file) — **do not add code that selects or stores a credential.** Two host-side caveats the runbook must call out: macOS subscription/enterprise OAuth lives in the **Keychain (no file)** so it won't appear in the mount — the dev runs `claude setup-token` once and exports `CLAUDE_CODE_OAUTH_TOKEN`; and Bedrock-via-SSO requires the host to keep `aws sso login` fresh (the container can't refresh the token itself).

## Harness ↔ Rails protocol (quick reference)

- **Rails → harness (`http://host.docker.internal:8787`, bearer-authed; configurable via `HARNESS_URL`):** `POST /runs` (409 if a run is active) · `POST /runs/:id/messages` (queued in the loop's inbox and appended to the RECORD at the next turn boundary, so a follow-up survives a crash — no respawn) · `POST /runs/:id/interrupt` · `GET /runs` · `GET /healthz`. `permission_mode` is **removed** — an Agent SDK concept, replaced by the `tool:before` extension point plus the per-run tool set. Run start carries `lane`, `provider`, `resume_context`, an `allowed_tools` pre-approval whitelist, and optional per-run scoping — `disallowed_tools` (the real disable → SDK `disallowedTools`), `connectors` (host-configured MCP server names → `mcpServers`), and `skills` (`"all"`|names → `settingSources`+`skills`); all default to today's behavior when omitted, and the resolved set is echoed in `run_started`. Discovery is host-owned + read-only: tools are a shared `packages/contracts` constant, connectors/skills are session-scoped (`GET /api/sessions/:id/connectors|skills`, proxied from the harness). `cwd` is pinned to the session worktree in all modes.
- **Harness → Rails:** `POST /internal/events` (batched, idempotent, bearer-authed with `HARNESS_SHARED_SECRET`, `store_seq` per durable event) · `POST /internal/harness/heartbeat` every 5s with `active_run_ids` + `store_seq_high_water`.
- **Crash recovery:** harness dies → its container restart policy reboots it; `Harness::HealthcheckJob` marks runs stale >15s as `failed`; recovery reads the **total position marker** from the session store and switches on its phase — it never replays the log, which is what keeps recovery O(1) in session length. Rails restart → harness ring-buffers events and retries with backoff; boot reconciliation marks orphaned runs failed.

## Commands & toolchain

The build files + wiring are all in place — these are the project's working commands.

- **Setup:** `bin/setup` (generates `HARNESS_SHARED_SECRET`, prepares env; the Postgres DBs are created by the rails container entrypoint, gated on postgres health).
- **Run the stack:** `bin/start` — brings up the `rails`, `jobs` (Solid Queue), `postgres` and (dev) `vite` containers, AND starts the harness as a host process, then reports the health of each and names whichever is down. `bin/stop` reverses it, harness first so it releases its store locks (a clean close does; a crash leaves them to age out). `bin/harness` manages the host process alone. Source is bind-mounted (`:delegated`); gems/node_modules live in named volumes; the harness read-only binds host `~/.claude` + `~/.aws` (credentials) and inherits the host's Claude/AWS auth env (so it uses the dev's existing login — API key, subscription/enterprise OAuth, or Bedrock — with no app-owned key). The **target repo is bind-mounted read-write** (Claude edits the worktree; reject reverts it) — only the credential mounts are read-only.
- **A session store refuses to open (`incompatible_version`):** the store schema is versioned and **refused, never migrated** (invariant 11) — misreading an older layout is how a record silently lies. So a store written before a `STORE_SCHEMA_VERSION` bump makes that session's runs fail with a harness 500. `bin/harness sessions` lists every store with its version and flags the refusable ones; `bin/harness reset-session <id>` moves the store aside (it does not delete it) so the session starts a fresh one. What is lost is that session's harness-side record — Postgres `events` keeps the projection, so the feed's history survives, but the session cannot resume its model conversation. Every store-schema bump gets a `docs/contracts/CHANGELOG.md` entry stating its own recovery step.
- **Lint/format:** **Biome** for `web/` and `harness/` (one tool, no ESLint/Prettier split); **RuboCop** (rubocop-rails + rubocop-rspec; line length 120, frozen string literals, required parens) for `api/`.
- **Tests / CI:** three independent GitHub Actions jobs — `api`: RuboCop + RSpec · `harness`: Biome + `tsc` + Vitest · `web`: Biome + `tsc` + Vitest. Web tests are **Vitest + React Testing Library**, `.test.tsx` co-located with components, **MSW** (`setupServer`) for REST mocking.
- Pinned toolchain: **Ruby 4.0.5, Node 24 LTS, PostgreSQL 18**; `openspec` v1.5.0. (CI pins these; note the host currently has Node 25.7.0 installed, so pin Node 24 in CI to avoid green-on-laptop / red-in-CI drift.)

## Engineering conventions (see `docs/PLAN.md §16`)

Standard Rails/React patterns chosen to keep a small MVP simple — match these:

- **Cable:** an ActionCable provider (connection-state Context bridged to React) mounted at `/~cable`; layer the buffer/backfill/drain cursor on top. Connection auth = `identified_by :current_user` + `find_verified_user` + `reject_unauthorized_connection`, where `find_verified_user` resolves the signed `clawd_uid` cookie.
- **Backend style:** single-responsibility service POROs (`Runs::Start`, `Events::Ingest`, `Git::WorktreeManager`); `rescue_from` → `render json: { errors: [...] }, status:`; one minimal factory per model with `sequence` for uniqueness; `annotaterb` for schema comments.
- **Frontend style:** `FC<Props>` components, **snake_case filenames**, flat `/hooks` + `/helpers`, nested provider composition; strict TS (`strict`, `isolatedModules`, `jsx: react-jsx`); Biome formatter = 2-space, double quotes, semicolons, with `noExplicitAny` / `useImportType` / `noConsole: error`; React Router 6+.
- **Authorization:** a single 4-role `SessionPolicy` PORO (owner/editor/reviewer/viewer) called in every controller action — no row/attribute-level authorization framework; the PORO is right-sized.
- **Out of scope (too heavy for this MVP):** a command/interactor framework (plain POROs are enough), enforced modular package boundaries, an external/cloud job queue (we use Solid Queue), a Redis cable adapter (we use Solid Cable), and a GraphQL stack (REST + the Contract-1 event envelope only).

## OpenSpec workflow

Non-trivial changes are designed via OpenSpec before implementation (schema `spec-driven`, config in `openspec/config.yaml`). The MVP's changes are archived under `openspec/changes/archive/`, and the living per-capability spec is in `openspec/specs/` (run `openspec list --specs`). Slash commands (defined in `.claude/commands/opsx/*.md`, backed by the `openspec-*` skills):

- `/opsx:explore` — think through a problem before committing to a change.
- `/opsx:propose <name-or-description>` — scaffold `openspec/changes/<name>/` and generate proposal → design → tasks → specs.
- `/opsx:apply` — work through a change's `tasks.md`.
- `/opsx:archive` — finalize a completed change into `openspec/specs/`.

Under the hood (`openspec` CLI, v1.5.0): `openspec new change "<kebab-name>"`, `openspec status --change "<name>" [--json]`, `openspec instructions <artifact-id> --change "<name>" --json`. The `context`/`rules` returned by `instructions ... --json` are **constraints for the author — never copy them into the artifact file.**

## Scope discipline

Five pieces ARE the product and are **never cut**: session create/join, chat, live activity stream, interrupt, and diff review + approve/reject. Already cut from MVP: the task board and a dedicated terminal tab (tool + terminal events already show in the activity feed). If a milestone slips >1 day, cut top-down per `docs/PLAN.md §12`: file tree/viewer → presence indicators → mid-run follow-ups → collapse roles to owner-vs-everyone → harness-restart session resume. **Out of MVP scope entirely:** multiplayer editing / CRDT / Monaco, remote access (Tailscale — future phase), per-tool live Bash approval, and merging session branches to main.
