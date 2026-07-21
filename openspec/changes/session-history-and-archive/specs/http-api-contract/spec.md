## MODIFIED Requirements

### Requirement: REST endpoint surface

The contract `docs/contracts/http_api.md` SHALL enumerate the client-facing REST endpoints and their roles, including at least: session create/join, **the per-user session list (`GET /api/sessions`)**, **owner session archive (`POST /api/sessions/:id/archive`)**, invite generation/use, run start (`POST /api/sessions/:id/runs`), follow-up and interrupt, event backfill (`GET /api/sessions/:id/events?after=<cursor>`), diff retrieval (`GET /api/runs/:id/diff`), changeset approve/reject, and file tree/content reads. Diffs SHALL be served over REST, never over cable.

The contract SHALL pin both the success and error response shapes for the client surface, establishing the convention once rather than re-specifying every endpoint. Event backfill SHALL return `200` with an ordered array of Contract-1 event envelopes, every element having `id` greater than the `<cursor>`, in ascending `id` order. **`GET /api/sessions` SHALL return `200` with an ordered array of the caller's session rows (shape defined by the `session-history` capability); it is a per-user index gated only by a valid `clawd_uid`, not scoped to one session, so an unauthenticated request is `404` (the shared `require_user` anti-enumeration posture). `POST /api/sessions/:id/archive` SHALL return `200` with `{ id, status: "archived" }` on success.** A request from a participant whose role is not permitted the action (per the role matrix below) SHALL be denied with `403` and a body of the form `{ errors: [...] }`, matching the `rescue_from` → `render json: { errors }` convention; this denial shape applies to every role-gated endpoint, making the role matrix testable. Each element of `errors` SHALL be an object with at least a human-readable `message` string field; additional fields (e.g. a `code`) MAY be added additively.

#### Scenario: Event backfill is cursor-based over REST

- **WHEN** a client needs to catch up
- **THEN** it calls `GET /api/sessions/:id/events?after=<cursor>` and receives events with `id` greater than the cursor

#### Scenario: Backfill success returns an ordered array of envelopes

- **WHEN** a client calls `GET /api/sessions/:id/events?after=<cursor>` and is permitted
- **THEN** the server responds `200` with an array of Contract-1 event envelopes, each with `id` greater than `<cursor>`, ordered ascending by `id`

#### Scenario: A non-permitted role is denied with 403 { errors }

- **WHEN** a participant whose role is not permitted the requested action calls a role-gated endpoint
- **THEN** the server responds `403` with a body of the form `{ errors: [...] }`, regardless of what the client UI shows

#### Scenario: The session list is a per-user index over REST

- **WHEN** a user with a valid `clawd_uid` cookie calls `GET /api/sessions`
- **THEN** the server responds `200` with an ordered array of that user's session rows (host or participant), and an unauthenticated request instead receives `404` with `{ errors: [...] }`

#### Scenario: Archive returns the terminal status on success

- **WHEN** an owner calls `POST /api/sessions/:id/archive`
- **THEN** the server responds `200` with `{ id, status: "archived" }`

### Requirement: Four-role permission matrix

The contract SHALL define the 4-role matrix as an explicit action×role table (read vs write distinguished, not conflated under "use"):

| action | owner | editor | reviewer | viewer |
|---|:---:|:---:|:---:|:---:|
| view / event backfill / read diffs & files | ✓ | ✓ | ✓ | ✓ |
| list own sessions (`GET /api/sessions`) | ✓ | ✓ | ✓ | ✓ |
| send `chat_message` | ✓ | ✓ | ✓ | ✓ |
| create / update tasks | ✓ | ✓ | ✓ | ✗ |
| start run / send follow-up / interrupt | ✓ | ✓ | ✗ | ✗ |
| approve / reject changeset | ✓ | ✗ | ✗ | ✗ |
| archive session | ✓ | ✗ | ✗ | ✗ |

(Per `docs/PLAN.md §9`: owner = everything incl. approve/reject; editor = runs/follow-ups/interrupt/tasks/chat; reviewer = tasks/chat/view; viewer = view/chat. The session list is not session-scoped — it is a per-user index gated only by a valid identity, so every role that can hold a cookie may call it for their own sessions; archive is owner-only, alongside approve/reject.)

The contract SHALL state that the server enforces this matrix on every endpoint and that cable subscriptions independently verify participantship; the client only hides buttons.

#### Scenario: Only owner may approve or reject

- **WHEN** a non-owner attempts to approve or reject a changeset
- **THEN** the server denies the action regardless of what the client UI shows

#### Scenario: Only owner may archive a session

- **WHEN** a non-owner participant attempts `POST /api/sessions/:id/archive`
- **THEN** the server denies the action with `403 { errors: [...] }` regardless of what the client UI shows

#### Scenario: Cable subscription verifies participantship

- **WHEN** a connection attempts to subscribe to a session channel
- **THEN** the server independently verifies the user is a participant before allowing the subscription
