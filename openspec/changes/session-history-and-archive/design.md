## Context

Sessions today have no read-back path and no lifecycle terminus. The web landing page
(`web/src/pages/landing_page.tsx`) is a placeholder; there is no endpoint that lists a user's
sessions; and although `sessions.status` is an `active | archived` enum (per `rails-data-model`),
nothing sets `archived`. Identity is the signed `clawd_uid` cookie resolving to one `User`
(`invite-auth`), and a user's relationship to a session is either `host_id` (creator) or a
`participants` row. This change consumes those existing seams — the cookie identity, the frozen
`http-api-contract` role matrix and 404-vs-403 anti-enumeration rule, and the
`Events::Append`-in-the-same-transaction invariant — and adds a per-user list plus an owner-only
archive transition.

## Goals / Non-Goals

**Goals:**
- A `GET /api/sessions` endpoint returning every session the caller hosts or participates in,
  de-duplicated, ordered by most recent activity, each row carrying the caller's role and status.
- Order by real activity, not creation time, via a denormalized `sessions.last_activity_at`.
- An owner-only `POST /api/sessions/:id/archive` that hard-closes a session (`active → archived`)
  and makes `Runs::Start` refuse on an archived session.
- A web home list rendering the sessions with an active/revoked badge and an owner "End session"
  action, with the server (not the client) enforcing the owner gate.

**Non-Goals:**
- Un-archive / reopen (archived is terminal), deleting sessions or their data.
- Pagination, search, or filtering of the history list (small MVP; a flat ordered list suffices).
- Any cable, sidecar, or event-envelope change — the list and archive are plain REST.
- A new event type for archival (archival is a session-status change, not a run-scoped event; it
  does not need to reconstruct through the run event stream).

## Decisions

**1. Denormalized `last_activity_at`, touched in `Events::Append`.**
The list must sort by activity, not `created_at`. Deriving `MAX(events.created_at)` per row is an
N-row correlated subquery on every home-page load; a denormalized `sessions.last_activity_at`
column is a single indexed sort key. `Events::Append` is the one write path every mutation already
funnels through (the append-in-the-same-transaction invariant), so touching the column there keeps
it current for free and in-transaction. *Alternative considered:* touch `sessions.updated_at` —
rejected because Rails touches `updated_at` for unrelated column writes (e.g. `repository_path`
edits), so it is not a faithful activity signal. Default `last_activity_at` to the session's
`created_at` at migration time so pre-existing sessions still sort sensibly.

**2. Union of host + participant, resolved in the controller, not a policy.**
"My sessions" = `host_id == me` ∪ sessions I have a `participants` row in. Since a creator is also
made an `owner` participant (`SessionsController#create_session_as_owner!`), the participant set
generally already covers hosted sessions; the union is belt-and-suspenders against any host row
without a participant row and keeps the intent explicit. The list is a **personal index** keyed by
the caller's identity — there is no single session to view-gate — so it is gated only by
`require_user` (a valid `clawd_uid`), consistent with how `DirectoriesController` gates a
non-session-scoped read. Each row's `my_role` comes from the caller's participant row (or `owner`
when they are the host without a participant row).

**3. Archive is an owner-only member action with its own policy verb.**
`POST /api/sessions/:id/archive` maps to a new `SessionPolicy` action (`archive`, owner-only),
reusing the established `authorize!` flow: unknown/non-participant → 404, participant-without-role
→ 403 (the frozen `http-api-contract` anti-enumeration rule). It sets `status: archived`. A
dedicated verb rather than overloading `manage_session` keeps the capability boundary clean and
lets the two owner actions diverge later.

**4. Hard close enforced in `Runs::Start`, not just the controller.**
`Runs::Start` gains an early guard raising `SessionArchived` when `@session.status == 'archived'`,
mapped by `RunsController`'s `rescue_from` to `409 { errors: [...] }`. Putting the guard in the
service (not only the controller) keeps the invariant true for every caller of `Runs::Start`,
matching how `ActiveRunExists` / `DirtyWorktree` already live in the service.

**5. Row shape reuses the derived-status convention.**
Each list row is `{ id, title, mode, status, my_role, last_activity_at, created_at }` with `id`
serialized as a string (the id-as-string envelope convention in `rails-data-model`). The web layer
maps `status == 'archived'` to the user-facing "revoked" badge and `active` to "active" — the same
server-derives-status / client-renders-label split used by `invite-management`.

## Risks / Trade-offs

- **[Backfilling `last_activity_at` on existing rows]** → the migration defaults the column to each
  session's `created_at` (or `NOW()`), so ordering is sensible immediately without a data job.
- **[`last_activity_at` write on the hot event path]** → it is a single indexed column update inside
  the transaction `Events::Append` already opens; negligible next to the event insert. If it ever
  matters, it can move to an async touch, but that would break in-transaction consistency, so keep
  it synchronous for now.
- **[Archived-but-in-flight run]** → archiving does not interrupt a currently-running run (the
  guard is only in `Runs::Start`); the active run finishes and its review still works. This is
  intended — archive blocks *new* runs, it is not a kill switch. Called out so it is not mistaken
  for a bug.
- **[List leaks session titles across users?]** → no: the union is strictly scoped to the caller's
  own host/participant rows, so a user only ever sees sessions they belong to; there is no
  cross-user enumeration.
