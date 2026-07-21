## Why

After the MVP, a user who created or joined sessions has no way to find them again: the landing
page is a placeholder, there is no endpoint that lists a user's sessions, and there is no way to
end a session. The `sessions.status` enum already defines `active | archived`, but nothing ever
sets `archived` — so sessions accumulate with no lifecycle and no history view. Users need a
personal home list showing every session they host or joined, each labelled active or revoked
(ended), plus an owner action to end a session as a hard close.

## What Changes

- Add a per-user session list endpoint (`GET /api/sessions`) returning every session where the
  requesting user is the host **or** a participant, de-duplicated and ordered by most recent
  activity, each row carrying the caller's role and the session status.
- Add a denormalized `sessions.last_activity_at` column, touched whenever an event is appended
  (`Events::Append`), so the list can order by real activity rather than `created_at`.
- Add an owner-only archive action (`POST /api/sessions/:id/archive`) that transitions a session
  `active → archived`. Archiving is a **hard close**: `Runs::Start` refuses to start a run on an
  archived session. There is no un-archive (**BREAKING** for a session lifecycle: archived is
  terminal).
- Turn the placeholder landing page into a real "home" list: session rows with title, mode, an
  active/revoked badge (revoked == archived), last-activity time, and a link into the session;
  owner rows get an "End session" button. The client only hides the button — the server enforces
  the role.

## Capabilities

### New Capabilities
- `session-history`: list the sessions a given user hosts or participates in (scoping, ordering,
  row shape, the per-user auth boundary) and its web home-list rendering.
- `session-archive`: the owner-only `active → archived` hard-close transition, its effect on
  `Runs::Start` (refuse on archived), and the role/anti-enumeration rules.

### Modified Capabilities
- `http-api-contract`: adds the `GET /api/sessions` and `POST /api/sessions/:id/archive`
  endpoints and their role matrix entries to the frozen REST surface.
- `rails-data-model`: adds `sessions.last_activity_at` and defines when it is touched.

## Impact

- **api/**: `config/routes.rb` (add `index` + member `archive` to `resources :sessions`),
  `app/controllers/sessions_controller.rb` (new `index` and `archive` actions),
  `app/policies/session_policy.rb` (an `archive` action, owner-only),
  `app/services/runs/start.rb` (refuse on archived + new `SessionArchived` error),
  `app/services/events/append.rb` (touch `last_activity_at`), a migration for
  `last_activity_at`, and `db/schema.rb` re-annotation.
- **web/**: `pages/landing_page.tsx` (home list), a new TanStack Query hook under `hooks/`, the
  REST client in `lib/`, and `routes.tsx`.
- **Tests**: RSpec request specs (list scoping/ordering, archive owner-gating, `Runs::Start`
  refusal on archived); Vitest + RTL + MSW for the list, badge states, and the archive button.
- No cable, sidecar, or contract-envelope changes; the list and archive are plain REST.
- Out of scope: un-archive/reopen, deleting sessions or their data, pagination/search of the
  history list, and archiving via any actor other than the owner.
