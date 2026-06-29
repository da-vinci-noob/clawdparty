## ADDED Requirements

### Requirement: ActionCable provider authenticated by the clawd_uid cookie

The `web/` package SHALL provide an ActionCable provider that creates a consumer against the `/~cable` mount
(per the frozen `http-api-contract`) and bridges connection state into React via Context, so hooks can read
connect/disconnect/connection status. The provider SHALL rely on the browser sending the signed httpOnly
`clawd_uid` cookie automatically on the WebSocket handshake — it SHALL NOT plumb a token through JavaScript,
consistent with the frozen rule that the same cookie authenticates REST and cable. The consumer factory
SHALL be injectable so tests can drive a fake channel without a real WebSocket.

#### Scenario: Provider connects at the cable mount

- **WHEN** the app mounts the ActionCable provider
- **THEN** it creates a consumer against `/~cable` and exposes connection state through React Context

#### Scenario: Cookie authenticates the cable connection

- **WHEN** the WebSocket handshake is made
- **THEN** the browser-sent signed `clawd_uid` cookie authenticates it, with no token plumbed through JavaScript

### Requirement: Gap-free late-joiner catch-up in cable.ts

`web/src/lib/cable.ts` SHALL implement the frozen `http-api-contract` gap-free catch-up sequence as the single
owner of catch-up/ordering logic: (1) subscribe to the session channel FIRST and begin buffering live events;
(2) REST-backfill `GET /api/sessions/:id/events?after=<cursor>`; (3) drain the buffer, applying **durable**
(non-null `id`) events only when their `id` is greater than the maximum backfilled `id`, while **always**
applying **ephemeral** (null-`id`) events buffered during catch-up; (4) transition to live pass-through. The
algorithm SHALL rely only on the envelope cursor (`id`) and on dedupe-by-`id` for durable events; it SHALL
NOT order on `seq` or `ts`.

#### Scenario: Mid-run joiner catches up without gaps or duplicates

- **WHEN** a client subscribes while a run is in progress
- **THEN** it buffers live events, backfills via REST, drains applying durable events only when `id` is greater
  than the max backfilled `id`, and transitions to live with no missed and no duplicated durable events

#### Scenario: Ephemeral event buffered during catch-up is not dropped

- **WHEN** an ephemeral (null-`id`) event arrives and is buffered before backfill completes
- **THEN** the drain applies it directly (it is exempt from the `id > max` filter, because a null `id` is never
  greater than the max), rather than discarding it

#### Scenario: Subscription happens before backfill

- **WHEN** catch-up begins
- **THEN** the client subscribes to the channel before issuing the REST backfill, so no event produced between
  backfill and going live is missed

### Requirement: Two-tier event store with dedupe and delta accumulation

The Zustand event store SHALL implement the frozen `event-envelope` two-tier model. **Durable** events SHALL be
stored keyed by their global `id` and deduped by `id`, so the same durable event arriving from both REST
backfill and live cable is applied exactly once. **Ephemeral** events SHALL NOT be stored in the durable
`id`-keyed structure and SHALL NOT be deduped by `id`: `ai_text_delta` SHALL be accumulated into in-progress
text keyed by `(ai_run_id, block)`, and `presence_changed` SHALL be applied last-writer-wins per participant.
The store SHALL expose selectors so that a flood of `ai_text_delta` mutates only the active text block and
does not re-render the durable event log.

#### Scenario: Durable event deduped by id across backfill and live

- **WHEN** the store receives the same durable event `id` from both REST backfill and live cable
- **THEN** it applies the event once, deduped by `id`

#### Scenario: Deltas accumulate by (ai_run_id, block) and are not deduped by id

- **WHEN** the store receives a sequence of `ai_text_delta` events (each with null `id`)
- **THEN** it accumulates them into in-progress text keyed by `(ai_run_id, block)` and does NOT dedupe them by
  `id`, so the text grows rather than collapsing to a single delta

#### Scenario: presence_changed is last-writer-wins per participant

- **WHEN** the store receives multiple `presence_changed` events for the same participant
- **THEN** the latest one wins for that participant and earlier presence state is not retained

### Requirement: app_provider composition is filled in without changing the shell

The `web/src/providers/app_provider.tsx` composition seam SHALL be filled in to nest the ActionCable provider
and the TanStack Query client (used for the REST backfill fetch), replacing the Week-1 "no store/query wired"
stub. The existing component structure (error boundary, app shell, routes) SHALL be preserved; this change
adds providers at the composition seam rather than restructuring the shell.

#### Scenario: Providers wired at the composition seam

- **WHEN** the app mounts through `app_provider`
- **THEN** the ActionCable provider and the TanStack Query client are composed in, and the W1 error boundary,
  app shell, and routes still render

### Requirement: Live delivery is provable with opaque payloads

The change SHALL prove end-to-end live delivery while treating each event's `payload` as opaque JSON, with no
dependency on the per-type payload schemas that are `pending-spike`. A minimal raw-list view SHALL render the
durable event log and in-progress text from the store, so that the existing `fake-claude-replay` broadcasting
over `SessionChannel` is watchable in the browser — including from multiple tabs and for a mid-run joiner —
without rich per-type rendering.

#### Scenario: The replay is watchable as a raw list

- **WHEN** the `fake-claude-replay` runs while a browser is subscribed to the session
- **THEN** the raw-list view shows the durable events arriving live, treating `payload` as opaque, with no
  dependency on per-type payload shapes

#### Scenario: A second tab joining mid-replay catches up

- **WHEN** a second browser tab subscribes after the replay has begun
- **THEN** it catches up via the documented sequence and converges to the same durable event set as the first
  tab, with no gap or duplicate

### Requirement: Reconnect re-runs catch-up idempotently from the last applied id

On a dropped and re-established cable connection, `cable.ts` SHALL re-run the subscribe → backfill → drain
sequence using the store's maximum applied durable `id` as the `<cursor>`, so a reconnect resumes without
gaps. Because durable events are deduped by `id`, re-draining already-applied events SHALL be idempotent.

#### Scenario: Reconnect resumes from the last applied id without duplicates

- **WHEN** the cable connection drops and re-establishes mid-run
- **THEN** `cable.ts` re-backfills from the store's max applied durable `id` and re-drains, and dedupe-by-`id`
  makes any re-applied durable event a no-op, so the stream resumes with no gap and no duplicate
