## ADDED Requirements

### Requirement: Session-channel connection and subscription

The web client SHALL open a single ActionCable connection to `/~cable` and subscribe to the session
channel for the active session, sending the shared `clawd_uid` cookie for authentication. All targets
SHALL be same-origin relative paths (the browser talks only to Rails); the client SHALL NOT assume
`localhost` or any fixed host. Every broadcast received SHALL be a Contract-1 `EventEnvelope` — the
client SHALL NOT expect or emit any bespoke cable message shape.

#### Scenario: Subscribe to a session

- **WHEN** the client mounts a session view with a valid `clawd_uid` cookie
- **THEN** it opens one `/~cable` connection and subscribes to that session's channel
- **AND** received messages are handled as `EventEnvelope` values with no custom message parsing

#### Scenario: Server rejects an unauthorized subscription

- **WHEN** the client attempts to subscribe to a session it is not a participant of
- **THEN** the server rejects the subscription (participantship is verified server-side)
- **AND** the client surfaces a disconnected/unauthorized connection state rather than crashing

### Requirement: Gap-free late-joiner catch-up

The client SHALL execute the catch-up sequence pinned in `http-api-contract` §6 in this order:
(1) subscribe to the cable channel first; (2) buffer live envelopes as they arrive; (3) backfill via
`GET /api/sessions/:id/events?after=<cursor>`, **advancing `<cursor>` to the max `id` of each page and
re-fetching until a page returns fewer than a full page (or empty)** — the client SHALL NOT assume the
whole history arrives in a single response; (4) drain the buffer applying **durable** (non-null `id`)
events only when `id` is greater than the maximum backfilled `id`, and **always** applying ephemeral
(null-`id`) events; (5) go live. The catch-up cursor SHALL be the envelope `id` only; `seq` and `ts`
SHALL NOT be used as cross-session cursors. Backfill returns **`200`** with an array of envelopes in
ascending `id` order; on error the response is `{ errors: [{ message }] }` and the client retries the
backfill without dropping buffered events.

> Page-aware from day one: the server returns a single unbounded array until `event-store-and-repo-apis`
> (change #9) introduces bounded pages. Writing the fetch loop to page now means #9 needs no client change.

#### Scenario: Late joiner receives no gap and no duplicate

- **WHEN** a client subscribes while a run is in progress, buffers live events, then backfills
- **THEN** durable backfilled events and buffered live events are merged with each durable event
  applied exactly once (deduped by `id`)
- **AND** no durable event between the backfill snapshot and the first buffered live event is missing

#### Scenario: Ephemeral events buffered during catch-up are not dropped

- **WHEN** an `ai_text_delta` or `presence_changed` (null `id`) is buffered during catch-up
- **THEN** the drain applies it (a null `id` is not `> max`, so it is exempt from the `id > max` filter)
- **AND** it is not discarded as a "stale" event

#### Scenario: Backfill spans multiple pages

- **WHEN** the backfill for a session returns a full page of durable events
- **THEN** the client advances the cursor to that page's max `id` and fetches again
- **AND** it stops only when a page returns fewer than a full page (or empty), having applied every
  durable event exactly once across pages

#### Scenario: Backfill request fails

- **WHEN** `GET /api/sessions/:id/events?after=<cursor>` returns a non-2xx `{ errors }` response
- **THEN** the client retains its buffered live events and retries the backfill
- **AND** it does not transition to live with a gap

### Requirement: Reconnect resync

On a dropped connection that reopens, the client SHALL resubscribe and re-run the catch-up sequence
with `after=<max applied durable id>` rather than replaying from zero, relying on dedupe-by-`id` to
make overlap a no-op. The client SHALL expose connection state (connecting / connected / disconnected)
to React via a context bridged from the ActionCable connection.

#### Scenario: Connection drops and recovers mid-run

- **WHEN** the cable connection drops and later reopens during an active run
- **THEN** the client resubscribes and backfills from the last applied durable `id`
- **AND** already-applied durable events are skipped (deduped by `id`) so state is unchanged by overlap
- **AND** the exposed connection state reflects disconnected then connected
