## ADDED Requirements

### Requirement: Events::Ingest persists, dedupes, and skips ephemeral events

`Events::Ingest` SHALL be the single ingestion service for events arriving from the sidecar or a replay. For durable event types it SHALL persist the event, deduping on `(ai_run_id, seq)` so a duplicate is silently skipped rather than inserted twice or raised as an error. For ephemeral types (`ai_text_delta` and `presence_changed`, per the frozen event-envelope capability) it SHALL NOT persist the event. The dedupe SHALL rely on the database `(ai_run_id, seq)` unique index, not a Ruby pre-check.

#### Scenario: Durable event is persisted once

- **WHEN** `Events::Ingest` is called with a durable event for a new `(ai_run_id, seq)`
- **THEN** the event is persisted exactly once

#### Scenario: Duplicate (ai_run_id, seq) is silently skipped

- **WHEN** `Events::Ingest` is called again with an event whose `(ai_run_id, seq)` is already persisted
- **THEN** the database uniqueness violation is caught, no duplicate row is created, and no error is surfaced to the caller

#### Scenario: Ephemeral event is not persisted

- **WHEN** `Events::Ingest` is called with an `ai_text_delta` or `presence_changed` event
- **THEN** the event is not written to the event store

### Requirement: Broadcast happens inside the ingest service

`Events::Ingest` SHALL broadcast every accepted event (both durable, after persistence, and ephemeral) to the session's subscribers via `SessionChannel.broadcast_to`. The broadcast SHALL occur inside the `Events::Ingest` code path and NOT in any controller, so that a caller invoking `Events::Ingest` directly (for example the fake-Claude replay) both persists and broadcasts identically to a sidecar-driven ingest.

#### Scenario: Direct ingest still broadcasts

- **WHEN** `Events::Ingest` is invoked directly in-process (not via HTTP) with an event
- **THEN** the event is broadcast to the session's subscribers via `SessionChannel.broadcast_to`, so a watching browser sees it

#### Scenario: Ephemeral events broadcast without persisting

- **WHEN** an ephemeral `ai_text_delta` is ingested
- **THEN** it is broadcast to subscribers but not persisted

#### Scenario: Broadcast ephemeral event serializes id as null

- **WHEN** an ephemeral event (`ai_text_delta` or `presence_changed`) is broadcast on `SessionChannel`
- **THEN** the broadcast envelope serializes BOTH `id` and `seq` as `null` — `id` because the event is broadcast-not-persisted and has no database id, and `seq` because an ephemeral event NEVER consumes a per-run `seq` per the frozen event-envelope rule — so the web reducer can treat it as ephemeral, bypassing backfill and not deduping it by `id`

### Requirement: Events::Append couples a mutation and its event in one transaction

`Events::Append` SHALL wrap a state mutation and the insertion of its corresponding event in a single database transaction, so that the event stream alone can reconstruct the UI and no mutation can commit without its event (or vice versa). Appended events SHALL flow through the same broadcast path as ingested events.

#### Scenario: Mutation and event commit together

- **WHEN** a mutation (such as posting a chat message or a participant joining) is performed through `Events::Append`
- **THEN** the state row and its corresponding event (such as `chat_message` or `participant_joined`) are committed in the same transaction
- **AND** if either insert fails, both roll back

#### Scenario: Appended event is broadcast

- **WHEN** `Events::Append` commits a mutation and its event
- **THEN** the event is broadcast to the session's subscribers through the same broadcast path used by `Events::Ingest`

### Requirement: Thin /internal/events controller with bearer authentication

`POST /internal/events` SHALL be a thin controller that only authenticates the request with the bearer `SIDECAR_SHARED_SECRET`, parses the batch envelope (whose body is `{ events: Event[] }` per the frozen sidecar-protocol capability), calls `Events::Ingest` for each event, and renders a response. It SHALL contain no ingestion, dedupe, broadcast, or persistence logic of its own. A request with a missing or invalid bearer token SHALL be rejected with HTTP `401` (matching the frozen sidecar-protocol capability, which pins `401`) and SHALL NOT ingest any event. The bearer `SIDECAR_SHARED_SECRET` comparison SHALL use a constant-time comparison (`ActiveSupport::SecurityUtils.secure_compare`) to resist timing attacks. A malformed batch — unparseable, missing the `events` key, or containing any element missing required envelope fields — is NOT parseable and SHALL be rejected with HTTP `422` and SHALL ingest nothing (atomic: a single bad-shape element rejects the whole batch). A null `id`, `ai_run_id`, or `seq` on an event element is VALID per the frozen event-envelope nullability rules (ephemeral events — `ai_text_delta`/`presence_changed` — carry null `id` and null `seq` for best-effort live broadcast; session-scoped non-run events carry null `ai_run_id` and null `seq`) and SHALL NOT count as a "missing required envelope field"; only a genuinely malformed element — missing `type`, `session_id`, `actor`, or `ts`, or an unparseable body — SHALL trigger the `422`. A parseable batch — one whose every element is well-formed — SHALL be ingested best-effort per event: each event is upserted independently and an already-persisted `(ai_run_id, seq)` duplicate is skipped, so one already-persisted event SHALL NOT abort the rest of the batch. On success the controller SHALL respond `200` with a body reporting the `accepted` and `skipped` counts (skipped = duplicates deduped on `(ai_run_id, seq)`); the `409` status is reserved for run-start conflicts and is NOT used by this batch endpoint.

#### Scenario: Missing or invalid secret is rejected

- **WHEN** a `POST /internal/events` request arrives without the correct `SIDECAR_SHARED_SECRET` bearer token
- **THEN** the request is rejected with HTTP `401` and no event is ingested

#### Scenario: Malformed batch is rejected with 422 and ingests nothing

- **WHEN** an authenticated `POST /internal/events` request arrives with a malformed batch — unparseable, missing the `events` key, or containing an element missing required envelope fields
- **THEN** the request is rejected with HTTP `422` and no event in the batch is ingested

#### Scenario: Valid ephemeral element with null id and seq is accepted, not 422'd

- **WHEN** an authenticated `POST /internal/events` request arrives with a batch containing a valid ephemeral element (e.g. `ai_text_delta`) whose `id` and `seq` are null but whose `type`, `session_id`, `actor`, and `ts` are present
- **THEN** the batch is accepted (not rejected with `422`), because null `id`/`seq` are valid per the frozen event-envelope nullability rules and do not count as missing required fields, and the ephemeral element is broadcast without being persisted

#### Scenario: Parseable batch is ingested best-effort per event

- **WHEN** an authenticated `POST /internal/events` request arrives with a parseable batch in which one event's `(ai_run_id, seq)` is already persisted
- **THEN** the controller still ingests the remaining valid events, responds `200`, and reports the already-persisted event in its `skipped` count and the rest in its `accepted` count

#### Scenario: Authenticated batch is delegated to Events::Ingest

- **WHEN** an authenticated `POST /internal/events` request arrives with a batch of events
- **THEN** the controller parses the batch and calls `Events::Ingest` once per event, performing no ingestion logic itself

#### Scenario: Re-POSTed batch is idempotent over the wire

- **WHEN** the same batch is POSTed twice to `/internal/events`
- **THEN** no duplicate events are persisted and the second request responds `200` reporting the duplicates in its skipped count, because dedupe is handled by `Events::Ingest` on `(ai_run_id, seq)`

### Requirement: Thin /internal/sidecar/heartbeat ack-only receiver

`POST /internal/sidecar/heartbeat` SHALL be a thin ack-only receiver that authenticates the request with the bearer `SIDECAR_SHARED_SECRET` using the same constant-time comparison (`ActiveSupport::SecurityUtils.secure_compare`) as `/internal/events`, accepts a body of `{ active_run_ids: [...] }`, and responds `200` with `{ ok: true }`. A request with a missing or invalid bearer token SHALL be rejected with HTTP `401`. The receiver exists in Week 1 because the sidecar POSTs this endpoint every 5s and its transport treats a `404` as FATAL; without a route the live `RAILS_INTERNAL_URL` would return a fatal `404`. In Week 1 the receiver SHALL do nothing with the body beyond acknowledging it — it SHALL NOT perform any stale-run reconciliation. The stale-run reconciliation (`Sidecar::HealthcheckJob` marking runs stale `>15s` as `failed`) remains a Week-2 change layered on top of this thin receiver.

#### Scenario: Valid bearer heartbeat is acknowledged

- **WHEN** a `POST /internal/sidecar/heartbeat` request arrives with the correct `SIDECAR_SHARED_SECRET` bearer token and a `{ active_run_ids: [...] }` body
- **THEN** the receiver responds `200` with `{ ok: true }` and performs no stale-run reconciliation

#### Scenario: Missing or invalid secret on heartbeat is rejected

- **WHEN** a `POST /internal/sidecar/heartbeat` request arrives without the correct `SIDECAR_SHARED_SECRET` bearer token
- **THEN** the request is rejected with HTTP `401`

### Requirement: SessionChannel streams Contract-1 events at /~cable

`SessionChannel` SHALL mount under the `/~cable` ActionCable endpoint and broadcast every live update as a frozen event-envelope (Contract-1) event — never as a bespoke cable message shape. Subscriptions SHALL verify participantship per the invite-auth capability before streaming.

#### Scenario: Only envelope events are broadcast

- **WHEN** any live update is broadcast on `SessionChannel`
- **THEN** it is delivered as an event-envelope event and not as a custom cable message

### Requirement: Late-joiner backfill endpoint

The system SHALL expose `GET /api/sessions/:id/events?after=<cursor>`. For a participant of that session it SHALL respond `200` with a body that is an ordered array of frozen event-envelope events whose `id` is greater than `<cursor>`, ascending by `id`, scoped to the requested session. The endpoint SHALL be authorized to a participant of THAT session only; a request for a session the requester is not a participant of SHALL respond `404` (NOT `403`), so the response does not confirm whether the other session exists.

#### Scenario: Backfill returns 200 with an ordered envelope array

- **WHEN** a participant of the session requests `GET /api/sessions/:id/events?after=<cursor>`
- **THEN** the response is `200` and its body is an array of event-envelope events with `id` greater than `<cursor>`, ordered ascending by `id` and scoped to that session

#### Scenario: Cross-session backfill is refused with 404

- **WHEN** a participant of session A requests session B's events
- **THEN** the request is rejected with `404` (not `403`, so the existence of session B is not confirmed) and no session B events are returned
