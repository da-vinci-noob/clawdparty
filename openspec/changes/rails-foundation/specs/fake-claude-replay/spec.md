## ADDED Requirements

### Requirement: fake-Claude rake task replays the fixture via direct ingest

A rake task SHALL replay `packages/contracts/fixtures/sample_run.jsonl` by calling `Events::Ingest` directly in-process for each fixture event, NOT by POSTing to `/internal/events`. Because it calls the service directly, the task SHALL run without a running Puma server and without a `SIDECAR_SHARED_SECRET`. The task SHALL target (creating if needed) a session, a `Participant` for that session, and an `ai_run` so the replayed events attach to a real run and a real participant. The created (or targeted) `ai_run`'s structural `requested_by` SHALL be set to that participant, and its structural `prompt` and `model` SHALL be set to a placeholder value each, so the run satisfies all of its `NOT NULL` structural columns (`status`, `requested_by`, `prompt`, `model`).

The task SHALL **remap** three ids on each fixture event so that no event references a row that does not exist in the fresh DB and so that repeated replays do not collide on the `(ai_run_id, seq)` unique index or the partial-unique active-run index: (1) each fixture event's `ai_run_id` to the freshly-created (or targeted) `ai_run` id, (2) each fixture event's `session_id` to the targeted session id, and (3) for user-kind events, each fixture event's actor participant id (`actor.id` → the persisted `actor_participant_id`) to the freshly-created (or targeted) participant id, rather than preserving the fixture's original ids. Each fixture event's `seq` SHALL be preserved as-is and paired with the remapped `ai_run_id`.

At the end of a replay the created (or targeted) `ai_run` SHALL be moved to a terminal status (`completed_clean`) so it no longer occupies the active-run slot. This reconciles the two replay modes: a subsequent **fresh** replay (new session + run each invocation) does not violate the partial-unique active-run index because the prior run is no longer active, while a **same-run re-run** (re-targeting the same session and run) remains idempotent because `Events::Ingest` dedupes on `(ai_run_id, seq)`.

#### Scenario: Replay runs without a server or shared secret

- **WHEN** the fake-Claude rake task is invoked
- **THEN** it reads `sample_run.jsonl` and calls `Events::Ingest` per line in-process, succeeding with no Puma running and no `SIDECAR_SHARED_SECRET` set

#### Scenario: Replay attaches events to a real session, participant, and run

- **WHEN** the rake task replays the fixture
- **THEN** it creates (or targets) a session, a `Participant` for that session, and an `ai_run` whose structural `requested_by` is set to that participant and whose structural `prompt` and `model` are each set to a placeholder value, and the events are ingested with each event's `ai_run_id` remapped to the run id, `session_id` remapped to the session id, and (for user-kind events) the actor participant id (`actor.id` → `actor_participant_id`) remapped to the created (or targeted) participant id, while preserving the fixture's `seq`, so the persisted `(ai_run_id, seq)` pairs reference the real run and no event references a nonexistent participant

#### Scenario: Remapping lets repeated replays avoid index collisions

- **WHEN** the rake task is run twice, each invocation creating a fresh session and `ai_run`
- **THEN** the second run's remapped `ai_run_id` differs from the first, so the replayed `(ai_run_id, seq)` pairs do not collide on the unique index and neither replay is rejected by the partial-unique active-run index

#### Scenario: End-of-replay moves the run to a terminal status

- **WHEN** the rake task finishes replaying the fixture against a created (or targeted) `ai_run`
- **THEN** the run is moved to a terminal status (`completed_clean`) so it no longer occupies the active-run slot, allowing a subsequent fresh replay to create a new active run without violating the partial-unique active-run index

### Requirement: Replay persists durable events and broadcasts everything

Because the replay goes through `Events::Ingest`, it SHALL persist durable events (deduped on `(ai_run_id, seq)`), skip persisting ephemeral events, and broadcast every event to the session's subscribers — so that a browser already subscribed to the session SHALL see the replayed run live. This is the Week-1 milestone (replay end-to-end, watchable).

#### Scenario: Durable events are stored and ephemeral ones are not

- **WHEN** the fixture is replayed
- **THEN** durable events are persisted while `ai_text_delta`/`presence_changed` events are broadcast but not persisted

#### Scenario: A subscribed browser sees the replay live

- **WHEN** a client is subscribed to the session channel and the rake task replays the fixture
- **THEN** the client receives each replayed event live over cable, because broadcast lives inside `Events::Ingest`

#### Scenario: Re-running the replay is idempotent

- **WHEN** the rake task is run twice against the same session and run with the same fixture
- **THEN** durable events are not duplicated, because `Events::Ingest` dedupes on `(ai_run_id, seq)`

### Requirement: Replay backs seeding and the happy-path system test

The same direct-ingest replay path SHALL be reusable for seeding a session and SHALL back one happy-path system test that asserts replaying the fixture produces the expected persisted events and broadcasts. The HTTP wire contract SHALL be verified separately by the `/internal/events` request spec, not by this replay path.

#### Scenario: System test verifies replay end-to-end

- **WHEN** the happy-path system test replays `sample_run.jsonl` through `Events::Ingest`
- **THEN** it asserts the durable events were persisted and that events were broadcast, without exercising the HTTP `/internal/events` boundary
