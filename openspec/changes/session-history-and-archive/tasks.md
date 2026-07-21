## 1. Data model — last_activity_at

- [x] 1.1 Add a migration adding `sessions.last_activity_at` (timestamp), defaulting new rows to `created_at` and backfilling existing rows to their `created_at`
- [x] 1.2 Run the migration and re-annotate models (`annotaterb`); confirm `Session` shows the new column
- [x] 1.3 In `Events::Append`, advance the session's `last_activity_at` to the append time within the same transaction as the event insert
- [x] 1.4 Spec: appending an event advances `last_activity_at` in the same transaction (`api/spec/services/events/append_spec.rb`)

## 2. Session list endpoint (GET /api/sessions)

- [x] 2.1 Add `index` to `resources :sessions` in `api/config/routes.rb`
- [x] 2.2 Implement `SessionsController#index`: resolve the current user (`require_user`), collect sessions where `host_id == me` unioned with sessions via `participants`, de-dup, order by `last_activity_at DESC`
- [x] 2.3 Serialize each row as `{ id (string), title, mode, status, my_role, last_activity_at (iso8601), created_at (iso8601) }`, deriving `my_role` from the caller's participant row (or `owner` when host without a participant row)
- [x] 2.4 Ensure an unauthenticated request returns `404 { errors: [...] }` (the shared `require_user` anti-enumeration posture)
- [x] 2.5 Request spec: host+participant scoping, dedup (host who is also owner participant appears once with `my_role: owner`), ordering by activity, exclusion of non-member sessions, and the 404 unauthenticated case (`api/spec/requests/sessions_index_spec.rb`)

## 3. Archive endpoint + hard-close guard

- [x] 3.1 Add a member `post :archive` to `resources :sessions` in `api/config/routes.rb`
- [x] 3.2 Add an owner-only `archive` action to `SessionPolicy` (PORO)
- [x] 3.3 Implement `SessionsController#archive`: `authorize!(:archive, session)`, set `status: archived` (idempotent), respond `200 { id, status: "archived" }`; unknown/non-participant → 404, non-owner → 403
- [x] 3.4 In `Runs::Start`, add a `SessionArchived` error and an early guard raising it when `@session.status == 'archived'`
- [x] 3.5 In `RunsController`, add `rescue_from Runs::Start::SessionArchived` → `409 { errors: [...] }`
- [x] 3.6 Request spec: owner archives (200 + status), idempotent re-archive, non-owner 403, non-participant/unknown 404 (`api/spec/requests/sessions_archive_spec.rb`)
- [x] 3.7 Service/request spec: `Runs::Start` refuses on an archived session → 409, and still starts on an active session (`api/spec/services/runs/start_spec.rb` + runs request spec)

## 4. Web home list

- [x] 4.1 Add a REST client call for `GET /api/sessions` and `POST /api/sessions/:id/archive` (in the `use_sessions` hook's fetchers); include `owned` on the row so the UI can group
- [x] 4.2 Add a TanStack Query hook (`web/src/hooks/use_sessions.ts`) fetching the session list, plus an archive mutation that invalidates the list on success
- [x] 4.3 Add a reusable grouped list (`web/src/components/session/session_list.tsx`): "Your sessions" (owned) + "Joined" (not owned), rows with title, last-activity, an active/revoked badge (only those two labels), and a link to `/sessions/:id`
- [x] 4.4 Render an owner-only "end session" control (shown when `my_role == owner` and not archived) wired to the archive mutation
- [x] 4.5 Add a dedicated `/sessions` page (`web/src/pages/sessions_page.tsx`) using the list; add a "sessions" header link in `landing_nav.tsx`; wire the `/sessions` route; replace the mock list in `SessionSidebar` with the real list; remove the landing-page history section
- [x] 4.6 Web tests (Vitest + RTL + MSW): list groups owned vs joined, badge maps archived→revoked and active→active, row links to the session, owner can click "end session" (calls endpoint + refetches → revoked), non-owner does not see it

## 5. Contract docs + verification

- [x] 5.1 Update `docs/contracts/http_api.md` with the two new endpoints and the role-matrix rows (list = any identity for own sessions; archive = owner-only); add a `docs/contracts/CHANGELOG.md` entry
- [x] 5.2 Run `cd api && bundle exec rspec && bundle exec rubocop` and `cd web && npx vitest run && npx tsc --noEmit && npx biome check` — all new/changed code green; the only remaining failures (api `worktree_manager` repo_root env test; web `activity_feed`/`event_store` `@clawdparty/contracts` import) are pre-existing container-config issues unrelated to this change
- [ ] 5.3 Manual end-to-end: create two sessions + join a third, load `/` → all three appear with correct badges/roles newest-first; archive one as owner → badge flips to revoked and a new run is refused (409); confirm a non-owner sees no archive button and the endpoint 403s them
