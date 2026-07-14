## ADDED Requirements

### Requirement: Reduce envelopes into session state

The event store SHALL accept `EventEnvelope` values and reduce them into session state by switching on
the frozen `type` taxonomy (the 20 types plus the `ai_raw` fallback). An unrecognized or `ai_raw`
envelope SHALL be retained without crashing the reducer. The store SHALL order durable events by `id`
(session scope) and within a run by `seq`, and SHALL NOT order by `ts` (display-only).

#### Scenario: Apply a durable event

- **WHEN** a durable envelope (non-null `id`) of a known type is applied
- **THEN** it is recorded in the store and reflected in the derived state for its scope
- **AND** ordering across the session follows `id`, not `ts`

#### Scenario: Unknown or ai_raw envelope

- **WHEN** an envelope with an unmapped type or `ai_raw` is applied
- **THEN** the store retains it without throwing and continues to accept subsequent events

### Requirement: Durable dedupe by id

The store SHALL dedupe durable events by `id`: applying the same durable `id` more than once (e.g. the
event arriving from both live cable and REST backfill) SHALL be a no-op that leaves state unchanged.

#### Scenario: Same durable event arrives twice

- **WHEN** a durable event with a given `id` is applied, then an event with the same `id` is applied again
- **THEN** the store holds exactly one copy and derived state is identical to the single-apply result

### Requirement: Streaming text accumulation

`ai_text_delta` events SHALL accumulate into an in-progress text block keyed by `(ai_run_id, block)`;
they are ephemeral (null `id`, null `seq`), are never persisted, and SHALL NOT advance any durable
counter. The durable `ai_text` event, emitted on block stop, SHALL be recorded as the block's final
text. Deltas SHALL accumulate in arrival order for their block.

#### Scenario: Deltas coalesce then finalize

- **WHEN** several `ai_text_delta` events for one `(ai_run_id, block)` arrive, followed by the block's `ai_text`
- **THEN** the in-progress block reflects the concatenated deltas while streaming
- **AND** on `ai_text` the block's durable final text is recorded
- **AND** no `seq` value was consumed by the deltas

### Requirement: Ephemeral and presence handling

Ephemeral events (null `id`: `ai_text_delta`, `presence_changed`) SHALL be exempt from id-dedupe.
`presence_changed` SHALL be applied last-writer-wins per participant, so the store reflects each
participant's most recent presence.

#### Scenario: Presence updates for a participant

- **WHEN** two `presence_changed` events for the same participant are applied in sequence
- **THEN** the store reflects only the most recent one for that participant

#### Scenario: Run lifecycle is derived from events

- **WHEN** `run_started` is applied, then later `run_finished` (or `run_failed` / `run_interrupted`)
- **THEN** the store's run state transitions accordingly, reconstructable from the event stream alone
