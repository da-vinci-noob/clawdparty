## ADDED Requirements

### Requirement: REST endpoint surface

The contract `docs/contracts/http_api.md` SHALL enumerate the client-facing REST endpoints and their roles, including at least: session create/join, invite generation/use, run start (`POST /api/sessions/:id/runs`), follow-up and interrupt, event backfill (`GET /api/sessions/:id/events?after=<cursor>`), diff retrieval (`GET /api/runs/:id/diff`), changeset approve/reject, and file tree/content reads. Diffs SHALL be served over REST, never over cable.

The contract SHALL pin both the success and error response shapes for the client surface, establishing the convention once rather than re-specifying every endpoint. Event backfill SHALL return `200` with an ordered array of Contract-1 event envelopes, every element having `id` greater than the `<cursor>`, in ascending `id` order. A request from a participant whose role is not permitted the action (per the role matrix below) SHALL be denied with `403` and a body of the form `{ errors: [...] }`, matching the `rescue_from` → `render json: { errors }` convention; this denial shape applies to every role-gated endpoint, making the role matrix testable. Each element of `errors` SHALL be an object with at least a human-readable `message` string field; additional fields (e.g. a `code`) MAY be added additively.

#### Scenario: Event backfill is cursor-based over REST

- **WHEN** a client needs to catch up
- **THEN** it calls `GET /api/sessions/:id/events?after=<cursor>` and receives events with `id` greater than the cursor

#### Scenario: Backfill success returns an ordered array of envelopes

- **WHEN** a client calls `GET /api/sessions/:id/events?after=<cursor>` and is permitted
- **THEN** the server responds `200` with an array of Contract-1 event envelopes, each with `id` greater than `<cursor>`, ordered ascending by `id`

#### Scenario: A non-permitted role is denied with 403 { errors }

- **WHEN** a participant whose role is not permitted the requested action calls a role-gated endpoint
- **THEN** the server responds `403` with a body of the form `{ errors: [...] }`, regardless of what the client UI shows

### Requirement: Unknown resource and non-participant access are 404, not 403

For a resource scoped to a session the requester is **not a participant of**, and for an invite token that is invalid, expired, or revoked, the server SHALL respond `404` with a body of the form `{ errors: [...] }`, and SHALL NOT distinguish these cases from a genuinely nonexistent resource — so the response never confirms existence (anti-enumeration / IDOR). The `403` denial above is reserved for a **participant of the session** whose role does not permit the action; cross-session and unknown-resource access is always `404`. Downstream specs (`invite-auth`, `event-ingest-pipeline`) implement this convention; pinning it here makes it the single source the client stream builds against.

#### Scenario: Cross-session or unknown resource is refused with 404

- **WHEN** a requester accesses a session they are not a participant of, or presents an invalid/expired/revoked invite token
- **THEN** the server responds `404` with `{ errors: [...] }`, indistinguishable from a genuinely nonexistent resource

#### Scenario: Participant-but-unauthorized stays 403

- **WHEN** a participant of the session requests an action their role does not permit
- **THEN** the server responds `403` (not `404`) — the requester is known to belong to the session, only the action is denied

#### Scenario: Diffs are REST-only

- **WHEN** a client needs a run's diff
- **THEN** it fetches `GET /api/runs/:id/diff` over REST, and no diff payload is delivered over cable

### Requirement: All live state arrives as a Contract-1 event

The contract SHALL state the rule that everything live arrives as an event-envelope (Contract-1) event over the cable, and that there SHALL be no bespoke cable message types. The ActionCable mount SHALL be `/~cable`, and the contract SHALL define the per-session subscription shape.

#### Scenario: No bespoke cable messages

- **WHEN** any live update is broadcast to subscribers
- **THEN** it is delivered as a Contract-1 event envelope and not as a custom cable message shape

#### Scenario: Cable mounts at /~cable

- **WHEN** a client opens the realtime connection
- **THEN** it connects at `/~cable` and subscribes to the session channel

### Requirement: Four-role permission matrix

The contract SHALL define the 4-role matrix as an explicit action×role table (read vs write distinguished, not conflated under "use"):

| action | owner | editor | reviewer | viewer |
|---|:---:|:---:|:---:|:---:|
| view / event backfill / read diffs & files | ✓ | ✓ | ✓ | ✓ |
| send `chat_message` | ✓ | ✓ | ✓ | ✓ |
| create / update tasks | ✓ | ✓ | ✓ | ✗ |
| start run / send follow-up / interrupt | ✓ | ✓ | ✗ | ✗ |
| approve / reject changeset | ✓ | ✗ | ✗ | ✗ |

(Per `docs/PLAN.md §9`: owner = everything incl. approve/reject; editor = runs/follow-ups/interrupt/tasks/chat; reviewer = tasks/chat/view; viewer = view/chat.)

The contract SHALL state that the server enforces this matrix on every endpoint and that cable subscriptions independently verify participantship; the client only hides buttons.

#### Scenario: Only owner may approve or reject

- **WHEN** a non-owner attempts to approve or reject a changeset
- **THEN** the server denies the action regardless of what the client UI shows

#### Scenario: Cable subscription verifies participantship

- **WHEN** a connection attempts to subscribe to a session channel
- **THEN** the server independently verifies the user is a participant before allowing the subscription

### Requirement: Cookie-based authentication for REST and cable

The contract SHALL specify that authentication uses a role-scoped reusable invite link exchanged for a signed httpOnly cookie (`clawd_uid`), with no `Secure` flag on the plain-HTTP LAN, and that the same cookie authenticates both REST requests and the ActionCable connection.

#### Scenario: One cookie authenticates REST and cable

- **WHEN** a participant has joined via an invite link and holds the signed `clawd_uid` cookie
- **THEN** that cookie authenticates both their REST requests and their cable connection

### Requirement: Late-joiner catch-up is gap-free

The contract SHALL define the gap-free catch-up sequence: subscribe to cable first, buffer live events, REST-backfill events after the cursor, drain the buffer applying only events with `id` greater than the maximum backfilled `id`, then go live. The `id > max` drain filter applies only to **durable** (non-null `id`) events; **ephemeral events (null `id`) are exempt from the filter and are always applied directly** (a null `id` is not `> max`, so a literal filter would wrongly drop ephemeral events buffered during catch-up). The catch-up algorithm SHALL rely only on the envelope cursor (`id`) and on dedupe-by-`id` for durable events.

#### Scenario: Mid-run joiner catches up without gaps or duplicates

- **WHEN** a client joins mid-run
- **THEN** it subscribes to cable first, buffers, backfills via REST, drains the buffer applying durable events only when `id` is greater than the max backfilled `id` while always applying ephemeral (null-`id`) events, and transitions to live with no missed or duplicated events
