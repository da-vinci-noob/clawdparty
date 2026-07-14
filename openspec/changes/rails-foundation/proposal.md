## Why

The three streams (`api/`, `sidecar/`, `web/`) can only build in parallel once the Rails backend exists to receive events, persist them, broadcast them, and gate access. This is **the Rails backend stream** (`docs/PLAN.md §10`): the Rails 8 API app, the 8-table data model with the two load-bearing constraints, invite-link auth, the `Events::Ingest`/`Events::Append`/`SessionChannel` pipeline, and a fake-Claude rake task. It consumes the now-frozen contracts (`event-envelope`, `sidecar-protocol`, `http-api-contract`, `contracts-package`) rather than re-deriving them. The W1 acceptance gate is: **Rails can replay `sample_run.jsonl` end-to-end through real ingest and a watching browser sees it** — which exercises the data model, ingest pipeline, broadcast, and cookie-authed cable, but not yet live Claude (that is W2).

## What Changes

- **Rails 8 API-only app scaffold** under `api/`: PostgreSQL 18 (3 databases — primary/queue/cable), Solid Queue + Solid Cable, RuboCop (rubocop-rails + rubocop-rspec; line length 120, frozen string literals, required parens), RSpec + FactoryBot (one minimal factory per model, `sequence` for uniqueness), annotaterb, and the `api` CI job (RuboCop + RSpec). Runs inside Docker via `bin/start`.
- **8-table data model** with enums and the **two load-bearing DB constraints**: (1) partial unique index on `ai_runs.session_id WHERE status IN ('queued', 'running', 'awaiting_review')` (quoted literals; `status` is a native PG enum) — one active run per session; (2) unique index on `events [ai_run_id, seq]` — idempotent ingest. The `ai_runs` state machine and `events.actor` shape are modeled to satisfy the frozen contracts.
- **Invite-link authentication**: SHA-256 token digests, role-scoped, optional expiry/revoke → join with a display name → signed httpOnly `clawd_uid` cookie (no `Secure` flag, plain-HTTP LAN). `ApplicationCable::Connection` authenticates via the same cookie. `SessionPolicy` PORO gates every controller action across the 4 roles; cable subscriptions independently verify participantship.
- **Event ingest pipeline**: `Events::Ingest` (persist-unless-ephemeral, dedupe on `(ai_run_id, seq)`, broadcast inside the service), `Events::Append` (every mutation appends an event in the same transaction), `SessionChannel`, and a **thin** `POST /internal/events` controller (bearer auth → parse batch → `Events::Ingest.call(each)` → render, with zero ingestion logic) plus a focused wire-contract request spec.
- **fake-Claude rake task** replaying `packages/contracts/fixtures/sample_run.jsonl` by calling `Events::Ingest` **directly in-process** (not over HTTP), so it works without a running server and powers both seeding and the happy-path system test.

This change scaffolds + models + authenticates + ingests + replays only. It does **not** build run orchestration, the sidecar HTTP client, the diff/file APIs, or the changeset service — those are W2/W3.

## Capabilities

### New Capabilities
- `rails-data-model`: The Rails 8 API scaffold (PostgreSQL 18, Solid Queue/Cable 3-DB setup, RuboCop/RSpec/FactoryBot/annotaterb toolchain, `api` CI job) and the 8-table schema with enums, the `ai_runs` state machine, the `events.actor` columns, and the two load-bearing indexes/constraints.
- `invite-auth`: Invite token digests (SHA-256, role-scoped, expiry/revoke), join → signed httpOnly `clawd_uid` cookie, the `SessionPolicy` 4-role matrix enforced server-side, and `ApplicationCable::Connection` cookie auth + per-channel participantship verification.
- `event-ingest-pipeline`: `Events::Ingest` (persist/dedupe/ephemeral-skip/broadcast-in-service), `Events::Append` (mutation + event in one transaction), `SessionChannel.broadcast_to`, the thin `POST /internal/events` controller, and its wire-contract request spec (auth rejection, batch shape, conflict handling).
- `fake-claude-replay`: The rake task replaying `sample_run.jsonl` through `Events::Ingest` in-process, tying to the W1 milestone (replay end-to-end, watchable from a browser) and seeding for the happy-path system test.
- `rails-dev-serving`: The Rails-side dev reverse-proxy (serve `/api` + `/~cable`, proxy the SPA/assets/Vite HMR WebSocket to the unpublished `vite` service in dev; serve the built SPA directly in production-style serving) and `config.hosts` + ActionCable allowed-origins config for `<host>.local`/LAN-IP, so single-port LAN access is not blocked by HostAuthorization or the cable origin check. The `dev-docker-compose` change owns the compose wiring (unpublished `vite`, single published `rails:3000`); the `web-scaffold` change owns the Vite-side HMR config (`server.host: true`, `server.hmr.clientPort: 3000`, `usePolling`).

### Modified Capabilities
<!-- None — greenfield repo. This change CONSUMES the frozen freeze-interface-contracts capabilities (event-envelope, sidecar-protocol, http-api-contract, contracts-package) but does not modify them. -->

## Impact

- **New code:** `api/` Rails app (models, migrations, `app/services/events/`, `app/channels/`, `app/controllers/internal/`, `app/policies/session_policy.rb`, `app/channels/application_cable/connection.rb`, the dev reverse-proxy middleware + `config.hosts`/cable-allowed-origins config, `lib/tasks/fake_claude.rake`, factories, request/service/connection specs), `.rubocop.yml`, `.rspec`, CI `api` job.
- **Consumes (does not modify):** the frozen `event-envelope` (envelope shape, `(ai_run_id, seq)` idempotency, dual cursor, ephemeral rule, `actor` discriminated union), `http-api-contract` (cookie auth for REST + cable, 4-role matrix, `/~cable` mount, events backfill endpoint), `sidecar-protocol` (`POST /internal/events` bearer auth + batch shape), and `contracts-package` (`fixtures/sample_run.jsonl`).
- **Dependencies:** PostgreSQL 18, Ruby 4.0.5, Rails 8, the Docker Compose dev runtime (`bin/start`) and `SIDECAR_SHARED_SECRET` from the dev-docker-compose change.
- **Cross-stream:** unblocks `web` (real backfill endpoint + cable to render against) and `sidecar` (a real `/internal/events` to POST to). No Claude/sidecar runtime is required for the W1 milestone — the replay path proves the pipeline server-side.

## Dependencies

- **`freeze-interface-contracts` is a hard prerequisite and SHALL be applied first.** This change is the first **consumer** of the frozen capabilities (`event-envelope`, `sidecar-protocol`, `http-api-contract`, `contracts-package`) and of the `packages/contracts/fixtures/sample_run.jsonl` fixture (replayed by `fake-claude-replay`). It consumes — and does not modify — those capabilities, so apply ordering is explicit: `freeze-interface-contracts` → `rails-foundation`.
- **Runtime:** the Docker Compose dev runtime (`bin/start`, three-DB `db:prepare`, `SIDECAR_SHARED_SECRET`) from the `dev-docker-compose` change. The `rails-dev-serving` capability above pairs with `dev-docker-compose` (compose wiring) and `web-scaffold` (Vite-side HMR config).
