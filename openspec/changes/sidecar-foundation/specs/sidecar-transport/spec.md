## ADDED Requirements

### Requirement: Batched, bearer-authenticated event POST to Rails

`sidecar/src/transport.ts` SHALL POST normalized Contract-1 event envelopes to Rails at `POST /internal/events` in batches, authenticated with the `SIDECAR_SHARED_SECRET` bearer token, consistent with the `sidecar-protocol` capability. The request body SHALL be the frozen `{ events: Event[] }` shape (a `events` array wrapping the batch), NOT a bare top-level array, per the `sidecar-protocol` capability. Durable events SHALL be sent on the idempotent, ring-buffered, retried batch path. Ephemeral `ai_text_delta`/`presence_changed` events SHALL ALSO be delivered to Rails (so Rails can live-broadcast them without persisting, per the `event-ingest-pipeline` capability), but on a **best-effort, fire-and-forget** path: because an ephemeral event carries a null `seq`, it SHALL NOT be ring-buffered, retried, or deduped on `(ai_run_id, seq)`. A DROPPED ephemeral event is acceptable (the durable `ai_text` block-stop record is the source of truth), but a NEVER-SENT ephemeral event is not — ephemeral events MUST reach Rails for live broadcast. They MAY ride the same `{ events: [...] }` POST to `/internal/events` (with null `id`/`seq`) or a separate fire-and-forget call; the wire mechanism is left to implementation, but delivery is required and buffering/retry/dedupe of ephemeral events is forbidden.

#### Scenario: Durable events are POSTed in authenticated batches

- **WHEN** the sidecar has durable normalized events to deliver
- **THEN** it POSTs them in a batch to `/internal/events` carrying the `SIDECAR_SHARED_SECRET` bearer token
- **AND** the request body is the frozen `{ events: Event[] }` shape, not a bare array

#### Scenario: Ephemeral events are delivered for live broadcast but not persisted

- **WHEN** the normalizer produces `ai_text_delta` or `presence_changed` events
- **THEN** the transport delivers them to Rails so Rails can live-broadcast them (Rails broadcasts without persisting, per the `event-ingest-pipeline` capability)
- **AND** the transport does NOT ring-buffer, retry, or dedupe these ephemeral events because their `seq` is null

#### Scenario: Ephemeral events are delivered for live broadcast but never buffered or retried

- **WHEN** an `ai_text_delta` is produced during a run
- **THEN** the transport delivers it to Rails on a best-effort, fire-and-forget path
- **AND** the transport SHALL NOT ring-buffer, retry, or dedupe it because its `seq` is null

### Requirement: Idempotent delivery keyed on (ai_run_id, seq)

The transport SHALL rely on the `event-envelope` capability's `(ai_run_id, seq)` idempotency rule so that re-POSTing a previously sent batch is safe. The transport SHALL NOT assume an event is lost merely because a POST failed; a retry of an already-ingested batch SHALL be acceptable because Rails silently skips duplicate `(ai_run_id, seq)` pairs.

#### Scenario: Re-POST of an already-ingested batch is safe

- **WHEN** the transport re-POSTs a batch whose `(ai_run_id, seq)` pairs were already persisted by Rails
- **THEN** delivery is idempotent — Rails skips the duplicates and the sidecar treats the retry as successful

### Requirement: Retried events keep their original (ai_run_id, seq) and are never re-sequenced

The `seq` of an event SHALL be assigned exactly once at normalization, NOT at send time. When the transport buffers and later retries an event, it SHALL re-send that event with the IDENTICAL `(ai_run_id, seq)` it was first assigned, and SHALL NOT renumber, reassign, or otherwise mutate `seq` (or `ai_run_id`) on retry. Renumbering on retry would change the idempotency key and defeat the `(ai_run_id, seq)` dedupe that the entire idempotency story rests on, so it is forbidden.

#### Scenario: A retried event carries the same (ai_run_id, seq) as its first send

- **WHEN** the transport retries a previously buffered event after a failed POST
- **THEN** the retried event carries the IDENTICAL `(ai_run_id, seq)` pair it was assigned at normalization
- **AND** the transport does NOT renumber or reassign `seq` on retry

### Requirement: Response handling distinguishes ack, transient failure, and fatal misconfiguration

The transport SHALL classify the response to each `POST /internal/events` callback into three handling paths. On a **2xx** response the batch SHALL be acked and cleared from the buffer. On a **5xx or network error** (a transient failure — Rails down, restarting, or unreachable) the transport SHALL buffer the affected events and retry with backoff. On a **4xx** response — including **401** (bad or missing `SIDECAR_SHARED_SECRET`), **403** (forbidden), **404** (callback endpoint not found / misrouted), and **422** (malformed batch — the status `/internal/events` returns for an unparseable or invalid-shape batch) — the transport SHALL treat the failure as **non-transient misconfiguration**: it SHALL NOT retry-forever and SHALL NOT silently buffer the batch as if it were a transient outage; instead it SHALL stop retrying that path, log a fatal error (an authentication error for 401, a misconfiguration error for 403/404, a malformed-batch error for 422), and surface the condition so the misconfiguration is visible rather than masked as a Rails outage. Any 4xx other than those enumerated SHALL likewise be treated as non-transient (never retried-forever), since a 4xx indicates the request, not Rails availability, is at fault. The distinction is: 5xx/network is transient-retry, while a 4xx (auth/forbidden/not-found/malformed) is fatal stop-and-log.

#### Scenario: 2xx acks and clears the batch

- **WHEN** a `POST /internal/events` batch receives a 2xx response
- **THEN** the transport acks the batch and clears those events from the buffer

#### Scenario: 5xx is treated as transient and retried

- **WHEN** a `POST /internal/events` batch receives a 5xx response or hits a network error
- **THEN** the transport buffers the affected events and retries delivery with backoff rather than discarding them

#### Scenario: 401 is fatal and not silently buffered

- **WHEN** a `POST /internal/events` batch receives a 401 (bad or missing `SIDECAR_SHARED_SECRET`)
- **THEN** the transport stops retrying that path, logs a fatal authentication error, and surfaces the condition
- **AND** it does NOT retry-forever or silently buffer the batch as a transient Rails outage

#### Scenario: 403 or 404 is non-transient and not retried forever

- **WHEN** a `POST /internal/events` batch receives a 403 (forbidden) or 404 (callback endpoint not found / misrouted)
- **THEN** the transport treats it as a non-transient misconfiguration, stops retrying that path, logs a fatal misconfiguration error, and surfaces the condition
- **AND** it does NOT retry-forever or silently buffer the batch as a transient Rails outage

#### Scenario: 422 malformed batch is non-transient and not retried forever

- **WHEN** a `POST /internal/events` batch receives a 422 (malformed or invalid-shape batch — the status `/internal/events` returns for a batch it cannot parse or validate)
- **THEN** the transport treats it as a non-transient failure, stops retrying that path, logs a fatal malformed-batch error, and surfaces the condition
- **AND** it does NOT retry-forever or silently buffer the batch as a transient Rails outage, so a permanently-malformed batch never evicts good events from the bounded ring buffer

### Requirement: Ring-buffer and retry-with-backoff when Rails is down

When a POST to `/internal/events` fails transiently (Rails unreachable, 5xx, or network error), the transport SHALL hold the affected events in an in-memory ring buffer and retry delivery with backoff, draining the buffer once Rails recovers. The sidecar SHALL continue running and accepting/normalizing events while Rails is down. The ring buffer SHALL be bounded; on overflow it SHALL evict the OLDEST unsent events and SHALL log the eviction as data loss (acceptable per the crash-recovery philosophy — a partial run is reviewed/rejected like any changeset, and clients also backfill via REST against the global cursor). Exact sizing/tuning is a Week-2 concern.

#### Scenario: Events are buffered while Rails is unavailable

- **WHEN** a POST to `/internal/events` fails because Rails is down
- **THEN** the transport retains the events in the ring buffer and retries with backoff rather than discarding them

#### Scenario: Ring buffer overflow evicts oldest and logs loss

- **WHEN** Rails is unreachable long enough to fill the bounded ring buffer
- **THEN** the oldest unsent events are evicted and the eviction is logged as data loss, while newer events continue buffering

#### Scenario: Buffer drains on Rails recovery

- **WHEN** Rails becomes reachable again after a failure
- **THEN** the transport re-POSTs the buffered events (idempotently) until the buffer is drained

#### Scenario: Sidecar keeps running during a Rails outage

- **WHEN** Rails is unreachable for a period
- **THEN** the sidecar continues to accept and normalize events and does not crash

### Requirement: Configurable Rails base URL

The transport SHALL obtain the Rails callback base URL from configuration and SHALL NOT hard-code it, consistent with the `sidecar-protocol` capability's no-hard-coded-host rule. This allows pointing at a stub/log sink before `rails-foundation` lands `/internal/events`, and at the real endpoint afterward, with no code change.

#### Scenario: Transport target is configurable

- **WHEN** the transport delivers events
- **THEN** it sends them to the configured Rails base URL, which can be switched between a stub sink and the real `/internal/events` without code changes
