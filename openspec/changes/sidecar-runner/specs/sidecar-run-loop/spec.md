## ADDED Requirements

### Requirement: POST /runs starts a query() in the worktree and returns the frozen success shape

`runner.ts` SHALL accept `POST /runs`, replacing the Week-1 `501` stub with the frozen `sidecar-protocol`
success shape `202 { run_id, status: "running" }`, and start a real `@anthropic-ai/claude-agent-sdk` `query()`
with `cwd` pinned to the session worktree (`repo_path` from the payload), `permission_mode: acceptEdits`, the
`allowed_tools` whitelist, and the optional `claude_session_id` for resume. The route signature SHALL be
unchanged from the skeleton. A `POST /runs` while a run is already active SHALL return `409` and SHALL NOT start
a second run.

#### Scenario: Accepted start returns 202 and starts the query in the worktree

- **WHEN** Rails POSTs a valid `/runs` with no run active
- **THEN** the runner responds `202 { run_id, status: "running" }` and starts `query()` with `cwd` = the session
  worktree, `permission_mode: acceptEdits`, and the `allowed_tools` whitelist

#### Scenario: Second concurrent start is rejected with 409

- **WHEN** a `POST /runs` arrives while a run is already active
- **THEN** the runner responds `409` and does not start a second run

#### Scenario: Optional claude_session_id resumes a session

- **WHEN** `POST /runs` carries a `claude_session_id`
- **THEN** the runner starts `query()` resuming that session (used by revise; absent on a fresh post-reject start)

### Requirement: run_started is emitted with the requesting participant as actor

The runner SHALL emit a `run_started` event with `actor = { kind: "user", id: <requested_by> }` from the
run-start payload, per the frozen `event-envelope`/`sidecar-protocol`. Per-run `seq` SHALL be scoped to this run
and SHALL NOT carry over from any prior run.

#### Scenario: run_started carries requested_by as actor

- **WHEN** the runner starts a run
- **THEN** it emits `run_started` with `actor = { kind: "user", id: <requested_by> }` and begins per-run `seq` at
  the run's first durable event

### Requirement: Streaming-input follow-ups push into the live run without respawning

`POST /runs/:id/messages` SHALL push the follow-up text into the live run's streaming-input iterable without
respawning the run, returning the frozen `200 { run_id, accepted: true }`. The `requested_by` from the message
body SHALL be carried onto follow-up-driven events' actor where applicable. A follow-up to an unknown or terminal
run SHALL be rejected (`404`/`409`), not pushed into a closed iterable.

#### Scenario: Follow-up is streamed into the active run

- **WHEN** `POST /runs/:id/messages` arrives during an active run
- **THEN** the message is pushed into the run's streaming-input iterable without respawning, and the runner
  responds `200 { run_id, accepted: true }`

#### Scenario: Follow-up to a finished run is rejected

- **WHEN** a follow-up arrives for an unknown or already-terminal run
- **THEN** the runner rejects it (`404`/`409`) rather than pushing into a closed iterable

### Requirement: Interrupt calls SDK interrupt() and emits a user-attributed run_interrupted

`POST /runs/:id/interrupt` SHALL call the SDK `interrupt()` on the active run and emit a `run_interrupted` event
with `actor = { kind: "user", id: <requested_by> }` (from the interrupt body), per the frozen mapping —
NOT `{ kind: "system" }` — returning `200 { run_id, accepted: true }`. The runner SHALL NOT transition the run
to a terminal state; Rails finalizes.

#### Scenario: Interrupt emits a user-attributed event and does not finalize

- **WHEN** `POST /runs/:id/interrupt` arrives with `{ requested_by }`
- **THEN** the runner calls SDK `interrupt()`, emits `run_interrupted` with `actor = { kind: "user", id:
  <requested_by> }`, responds `200 { run_id, accepted: true }`, and does NOT itself move the run to
  `awaiting_review`

### Requirement: The runner emits lifecycle events but never finalizes run state

The runner SHALL emit `run_finished`/`run_failed`/`run_interrupted` as the run concludes, but SHALL NOT transition
the run's persisted state — Rails (`run-lifecycle`) owns finalization, driven by these events. `run_finished`/
`run_failed` SHALL be `system`-attributed per the frozen per-type table.

#### Scenario: Lifecycle events are emitted, finalization left to Rails

- **WHEN** a run completes, fails, or is interrupted
- **THEN** the runner emits the corresponding lifecycle event (`run_finished`/`run_failed` as `system`,
  `run_interrupted` as `user`) and does not transition the run's state itself

### Requirement: /healthz and the heartbeat report the real active run ids

With the runner present, `GET /healthz` and the 5-second heartbeat SHALL report the actually-active run ids in
`active_run_ids` (no longer the empty skeleton set), per the frozen `sidecar-protocol`.

#### Scenario: Active run is reported in healthz and heartbeat

- **WHEN** a run is active
- **THEN** both `GET /healthz` and the heartbeat body report that run's id in `active_run_ids`

### Requirement: The runner preserves three frozen guards

The runner SHALL preserve three guards already frozen by upstream capabilities, restated here so an implementer
cannot drift: (a) ephemeral events (`ai_text_delta`/`presence_changed`) SHALL NOT consume the per-run `seq` —
`seq` is assigned only to durable run-scoped events (`event-envelope`); (b) the runner SHALL NOT create or
relocate the worktree — Rails creates it and the runner only uses the provided `repo_path` as `cwd`
(`sidecar-protocol` / `worktree-management`); (c) `canUseTool` SHALL remain the allow-all MVP stub and the
runner SHALL introduce NO shell input path (`claude-auth-passthrough`), preserving the read-only-terminal
invariant.

#### Scenario: Ephemeral events do not consume seq during a live run

- **WHEN** the runner drives a run emitting `ai_text_delta` events between durable events
- **THEN** the deltas carry null `seq`/`id` and the next durable event takes the next `seq` as though the deltas
  had not been emitted

#### Scenario: The runner uses but does not create the worktree

- **WHEN** the runner starts a run
- **THEN** it uses the provided `repo_path` as `query()`'s `cwd` and does not create or relocate the worktree

#### Scenario: No shell input path is introduced

- **WHEN** the runner is in place
- **THEN** `canUseTool` remains allow-all and no path for input to a shell is added (the terminal pane stays a
  read-only replay of Claude's Bash events)
