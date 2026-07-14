## 1. Rails scaffold + toolchain (rails-data-model)

- [x] 1.1 Generate the Rails 8 API-only app under `api/` targeting Ruby 4.0.5 + PostgreSQL 18; confirm it boots inside the Docker dev runtime via `bin/start`
- [x] 1.2 Configure `config/database.yml` with three connections — `primary`, `queue`, `cable` — and wire Solid Queue to `queue` and Solid Cable to `cable` (no Redis)
- [x] 1.3 Add `.rubocop.yml` inheriting `rubocop-rails` + `rubocop-rspec` (line length 120, frozen string literals, `Style/MethodCallWithArgsParentheses: require_parentheses`)
- [x] 1.4 Set up RSpec + FactoryBot (`spec_helper`/`rails_helper`, factory autoloading) and annotaterb
- [x] 1.5 Add the `api` CI job (RuboCop + RSpec); confirm it runs green on the empty scaffold

## 2. Data model + load-bearing constraints (rails-data-model)

- [x] 2.1 Migrations for `users`, `sessions`, `invites`, `participants`, `tasks`
- [x] 2.2 Migration for `ai_runs` with the nine-state `status` stored as a **PostgreSQL native enum type** (NOT integer-backed, so the partial-index string literals `'queued'`/`'running'`/`'awaiting_review'` match the stored values directly) (`queued`/`running`/`awaiting_review`/`approved`/`rejected`/`superseded`/`completed_clean`/`failed`/`interrupted`) plus `prompt`, `claude_session_id`, `model`, `base_sha`, `total_cost_usd`, `usage`, `diff_stats`, `requested_by`, `reviewed_by`; mark the W2-only columns (`base_sha`, `claude_session_id`, `reviewed_by`, `total_cost_usd`, `usage`, `diff_stats`) nullable and `status`, `prompt`, `model` `NOT NULL` (the latter two are structural always-present columns). (The other enums — `participants.role`, `tasks.status`, `messages.kind` — are not referenced by any DB index/constraint predicate, so they MAY use string-backed Rails enums.)
- [x] 2.3 Migration for `messages` (kind enum `user`/`claude`/`system`) and `events` (`event_type`, `actor_kind` enum, nullable `actor_participant_id`, `ai_run_id`, `seq`, `payload` `jsonb`); `session_id`/`event_type`/`actor_kind` `NOT NULL`; envelope `ts` derives from `created_at` (no separate `ts` column)
- [x] 2.4 Add the partial unique index on `ai_runs.session_id WHERE status IN ('queued','running','awaiting_review')`
- [x] 2.5 Add the unique index on `events [ai_run_id, seq]`
- [x] 2.6 Add the `events` check constraint: `actor_participant_id` non-null iff `actor_kind = 'user'`
- [x] 2.7 Models + enums + associations; `participants.role` enum (`owner`/`editor`/`reviewer`/`viewer`), `tasks.status` enum; mark `events`/`messages` append-only
- [x] 2.8 One minimal factory per model (`sequence` for uniqueness, no eager unrelated associations); run annotaterb
- [x] 2.9 Model specs asserting both indexes (duplicate active run → `RecordNotUnique`; duplicate `(ai_run_id, seq)` → `RecordNotUnique`) and the actor check constraint; assert non-active prior run does not block a new run

## 3. Invite-link auth + policy + cable connection (invite-auth)

- [x] 3.1 Invite generation: random token → store SHA-256 `token_digest`, `role`, optional `expires_at`; support revoke; raw token returned once
- [x] 3.2 Join action: hash presented token → look up digest → reject if expired/revoked → find-or-create `User` by display name → create `Participant` with the invite's role. The participant's role SHALL be derived solely from the invite; any client-supplied `role` param SHALL be ignored (never read it into the `Participant`)
- [x] 3.3 Set the signed httpOnly `clawd_uid` cookie (no `Secure` flag) on successful join
- [x] 3.4 `SessionPolicy` PORO encoding the 4-role matrix (owner/editor/reviewer/viewer) from the frozen http-api-contract capability; call it in every controller action
- [x] 3.5 `ApplicationController` `rescue_from` → `render json: { errors: [...] }, status:` for policy denials and validation errors
- [x] 3.5a Re-enable signed cookies under API-only mode: `config.middleware.use ActionDispatch::Cookies` and `include ActionController::Cookies` in the base API controller, so `cookies.signed[:clawd_uid]` can be both set and read (omitted by default when `config.api_only = true`)
- [x] 3.6 `ApplicationCable::Connection`: `identified_by :current_user` + `find_verified_user` (signed `clawd_uid` cookie) + `reject_unauthorized_connection`
- [x] 3.7 Request specs: join with valid/expired/revoked token; a forged `role=owner` param on join yields the invite's role (not `owner`); role-matrix denial (non-owner approve/reject denied); cookie authenticates a follow-up REST request
- [x] 3.8 `ApplicationCable::Connection` connection/channel spec: a missing or forged `clawd_uid` cookie is rejected via `reject_unauthorized_connection`; a valid-cookie connection subscribing to a session it is not a participant of is rejected

## 4. Event ingest pipeline (event-ingest-pipeline)

- [x] 4.1 `Events::Ingest`: classify ephemeral (`ai_text_delta`/`presence_changed`) vs durable; persist durable with dedupe on `(ai_run_id, seq)` (rescue `RecordNotUnique` → skip); never persist ephemeral
- [x] 4.2 Broadcast every accepted event (durable after persist; ephemeral too) via `SessionChannel.broadcast_to` — inside `Events::Ingest`, never in a controller
- [x] 4.3 `Events::Append`: wrap mutation + corresponding event insert in one transaction; route through the same broadcast path
- [x] 4.4 `SessionChannel` mounted at `/~cable`; `subscribed` verifies participantship before `stream_for`; broadcasts only envelope (Contract-1) events
- [x] 4.5 Thin `POST /internal/events` controller: bearer `SIDECAR_SHARED_SECRET` auth → parse batch → `Events::Ingest.call(each)` → render; zero ingestion logic
- [x] 4.6 Thin `POST /internal/sidecar/heartbeat` ack-only receiver: same bearer `SIDECAR_SHARED_SECRET` constant-time auth path as `/internal/events`; accept `{ active_run_ids: [...] }`; respond `200 { ok: true }`; do nothing with the body in W1 (the stale-run reconciliation `Sidecar::HealthcheckJob` is W2) — exists so the sidecar's every-5s heartbeat does not hit a routeless Rails (a `404` the sidecar transport treats as FATAL)
- [x] 4.7 Service specs: durable persisted once; duplicate `(ai_run_id, seq)` silently skipped; ephemeral broadcast-not-persisted; direct call still broadcasts; `Events::Append` rolls back both on failure
- [x] 4.8 `/internal/events` request spec (wire contract): reject missing/invalid bearer token with HTTP `401` (no events ingested), matching the frozen sidecar-protocol; authenticated batch delegates to `Events::Ingest`; re-POSTed batch responds `200` reporting accepted + skipped counts (skipped = `(ai_run_id, seq)` duplicates); `409` is reserved for run-start conflicts and not used by this endpoint
- [x] 4.9 `/internal/sidecar/heartbeat` request spec: valid bearer → `200 { ok: true }`; missing/invalid bearer → `401`
- [x] 4.10 Channel spec: non-participant subscription rejected; participant subscription streams
- [x] 4.11 Late-joiner backfill endpoint `GET /api/sessions/:id/events?after=<cursor>` responding `200` with an ordered array of envelope events (`id > cursor`, ascending by `id`), scoped to the session; cross-session access responds `404` (not `403`, so session B's existence is not confirmed); request spec asserting the `200` ordered-array body shape + the `404` cross-session refusal

## 5. fake-Claude replay (fake-claude-replay)

- [x] 5.1 Rake task reading `packages/contracts/fixtures/sample_run.jsonl`, creating/targeting a session + `Participant` + `ai_run` (setting the run's structural `requested_by`, `prompt`, and `model` so all `NOT NULL` structural columns are satisfied), calling `Events::Ingest` per line in-process (no Puma, no `SIDECAR_SHARED_SECRET`) — *(note: runs against the hand-authored envelope-only placeholder fixture pre-spike, the real captured fixture post-spike; per design.md Decision 9, W1 treats `payload` as opaque so the placeholder is sufficient)*
- [x] 5.2 Confirm replay persists durable events (deduped), skips ephemeral, and broadcasts every event; re-running is idempotent
- [x] 5.3 Reuse the replay path for session seeding
- [x] 5.3a Assert `CONTRACT_VERSION` compatibility (exact `major`, `minor >=` required) at boot/test time from a consumer (the fake-claude-replay or the contracts-type-import path), so the contracts-package governance mechanism is actually exercised by at least one consumer
- [x] 5.4 One happy-path system test: replay the fixture → assert durable events persisted and events broadcast (no HTTP `/internal/events` involvement) — *(note: runs against the envelope-only placeholder fixture pre-spike, the real captured fixture post-spike; per design.md Decision 9 the placeholder is sufficient because W1 treats `payload` as opaque)*

## 6. Dev serving + LAN host config (rails-dev-serving)

- [x] 6.1 Rails-side dev reverse-proxy middleware: serve `/api` and `/~cable` in Rails, reverse-proxy all other requests (SPA, assets, and the Vite HMR WebSocket upgrade) to the unpublished `vite` service over the compose network in development; serve the built SPA directly in production-style serving (compose wiring owned by `dev-docker-compose`; Vite-side HMR config — `server.host: true`, `server.hmr.clientPort: 3000`, `usePolling` — owned by `web-scaffold`)
- [x] 6.2 Configure `config.hosts` to allow `<host>.local` + the LAN IP, and set ActionCable allowed origins for `.local`/LAN-IP, so HostAuthorization and the cable origin check do not block cross-machine LAN access on the single published `rails:3000` port
- [x] 6.3 Spec/check: a request with a `.local` Host header is allowed (not blocked by HostAuthorization); a LAN browser loading `http://<host>.local:3000` in dev gets the SPA + a working HMR websocket proxied to `vite`

## 7. Milestone verification

- [x] 7.1 End-to-end: subscribe a client to a session, run the replay, confirm the client receives the live stream (the W1 "replay end-to-end, watchable" milestone) — *(note: runs against the envelope-only placeholder fixture pre-spike, the real captured fixture post-spike; per design.md Decision 9 the placeholder is sufficient because W1 treats `payload` as opaque)*
- [x] 7.2 Cross-check persisted `event_type` values against the frozen event-envelope taxonomy (one of the 20 frozen type names or `ai_raw`); confirm `api` CI job (RuboCop + RSpec) is green
