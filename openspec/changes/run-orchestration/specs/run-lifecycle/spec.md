## ADDED Requirements

### Requirement: Runs::Start enforces one active run per session

`Runs::Start` SHALL create a new `ai_run` only when the session has no active run (status in
`queued`/`running`/`awaiting_review`). The one-active-run guarantee SHALL rest on the database partial unique
index (not a Ruby-only check): a concurrent second start SHALL be rejected by the index
(`ActiveRecord::RecordNotUnique`), surfaced as a `409` by the run-control endpoint. A non-active prior run (a
terminal status) SHALL NOT block a new run.

#### Scenario: Second concurrent start is rejected

- **WHEN** two run-starts race for a session with no active run
- **THEN** exactly one succeeds and the other is rejected via the partial unique index, surfaced as a `409`

#### Scenario: A terminal prior run does not block a new start

- **WHEN** a session's prior run is in a terminal status (e.g. `completed_clean`, `rejected`, `failed`)
- **THEN** `Runs::Start` can create a new active run for that session

### Requirement: Runs::Start creates the worktree, records base_sha, and calls the sidecar

`Runs::Start` SHALL, on a non-revise start, require a clean worktree, then: create the worktree and record
`base_sha` (via `Git::WorktreeManager`), create the `ai_run` (`queued`, `requested_by` = the requesting
participant), and call the sidecar `POST /runs` via `Sidecar::Client`. The `/runs` payload SHALL carry
`requested_by` sourced from `ai_runs.requested_by`, `repo_path` set to the session worktree,
`permission_mode: acceptEdits`, and the `allowed_tools` whitelist, per the frozen `sidecar-protocol`. The client
SHALL respond to the caller without waiting for run completion (the run advances via ingested events).

`Runs::Start` SHALL NOT itself emit the `run_started` event: per the frozen `sidecar-protocol`, the **sidecar**
emits `run_started` (stamping `actor = { kind: "user", id: <requested_by> }` from the payload) as the first
run-scoped, `seq`-bearing event. Rails learns the run is live by ingesting that event and transitioning the run
`queued → running` (see the finalize requirement). This avoids a duplicate `run_started` and a `seq` conflict.

#### Scenario: Start creates the worktree and posts the contract payload

- **WHEN** `Runs::Start` runs for a clean session worktree
- **THEN** it creates the worktree, records `base_sha`, creates the `queued` run, and POSTs `/runs` with
  `requested_by`, `repo_path` = the worktree, `permission_mode: acceptEdits`, and `allowed_tools` — WITHOUT
  emitting its own `run_started` event

#### Scenario: run_started is the sidecar's event, carrying the requester

- **WHEN** the run starts
- **THEN** the `requested_by` Rails sent is what the sidecar stamps as `run_started.actor = { kind: "user", id }`,
  so the single `run_started` event (sidecar-emitted, run-scoped, `seq`-bearing) carries the requesting
  participant — Rails does not append a second one

### Requirement: Reject severs claude_session_id; only revise resumes

`Runs::Start` SHALL accept a mode. On a **revise**, it SHALL supersede the prior run (transition it to
`superseded`), keep the dirty worktree, and pass the prior `claude_session_id` to the sidecar so Claude resumes
the session. On a **fresh** start following a reject, it SHALL NOT pass any `claude_session_id` — the next run
begins a new Claude session, because the reverted worktree no longer matches the prior session's context. This
realizes the reject-severs-chaining correctness rule.

#### Scenario: Revise resumes the prior Claude session

- **WHEN** `Runs::Start` runs in revise mode against a run with a `claude_session_id`
- **THEN** it transitions the prior run to `superseded`, keeps the dirty tree, and passes `claude_session_id` to
  the sidecar so the session resumes

#### Scenario: Fresh start after a reject does not resume

- **WHEN** `Runs::Start` runs a fresh (non-revise) start after a prior run was rejected
- **THEN** it does NOT pass `claude_session_id` to the sidecar, so a new Claude session begins against the
  reverted worktree

### Requirement: Runs::Finalize transitions runs from ingested lifecycle events

`Runs::Finalize` SHALL move a run through its state in response to ingested run-lifecycle events, not by
polling. On `run_started` (the sidecar's first event) it SHALL transition the run `queued → running`. On a
terminal event: `run_finished` → `completed_clean` (clean worktree) or `awaiting_review` (a changeset is ready);
`run_failed` → `failed`; `run_interrupted` → `awaiting_review` when the worktree is dirty, else `completed_clean`.
The sidecar SHALL NOT finalize run state; Rails owns every transition. Finalization SHALL be driven from
the event-ingest path so the event stream remains the single source of run status (no bespoke run-status cable
message).

#### Scenario: run_started transitions queued → running

- **WHEN** the sidecar's `run_started` event is ingested for a `queued` run
- **THEN** `Runs::Finalize` transitions the run to `running` (Rails owns the transition; the sidecar only emitted
  the event)

#### Scenario: run_finished finalizes based on worktree state

- **WHEN** a `run_finished` event is ingested for a run
- **THEN** `Runs::Finalize` transitions the run to `completed_clean` if the worktree is clean, or
  `awaiting_review` if a changeset is ready

#### Scenario: run_interrupted with a dirty tree awaits review

- **WHEN** a `run_interrupted` event is ingested and the worktree is dirty
- **THEN** `Runs::Finalize` transitions the run to `awaiting_review` (Rails finalizes; the sidecar only emitted
  the event)

#### Scenario: run_interrupted with a clean tree completes clean

- **WHEN** a `run_interrupted` event is ingested and the worktree is clean (nothing to review)
- **THEN** `Runs::Finalize` transitions the run to `completed_clean`

#### Scenario: run_failed finalizes as failed

- **WHEN** a `run_failed` event is ingested
- **THEN** the run transitions to `failed`
