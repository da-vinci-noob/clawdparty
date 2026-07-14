## Why

Week 1 modeled the `ai_runs` nine-state machine as *values* and enforced the one-active-run partial unique
index at the DB — but there are **no transitions and no orchestration**. Nothing creates a worktree, records
`base_sha`, starts a run, calls the sidecar, or moves a run through its lifecycle. The `POST /runs` sidecar
endpoint exists as a frozen contract; the Rails side that calls it does not.

This is the **Rails run-orchestration stream of Week 2** (`docs/PLAN.md §10`, Snehal: run orchestration +
worktree + role checks): the seam that turns "a row exists in `ai_runs`" into "Claude is actually working in
an isolated worktree." It is the A↔B integration point — the riskiest part of the whole system, because the
git-worktree convention spans two containers running as different uids (a hazard W1 already hit once). It
depends on `rails-foundation` (the model, `SessionPolicy`, `Events::Append`) and the frozen `sidecar-protocol`
(the `POST /runs` shape), and it is the Rails half that `sidecar-runner` (the sidecar half) pairs with.

It needs **nothing from the SDK spike** — it deals in run lifecycle, worktrees, and HTTP, all of which are
envelope/protocol-level, not payload-level. (The events the run emits carry payloads, but Rails treats them as
opaque on ingest.)

## What Changes

- **`Git::WorktreeManager`** — creates the per-session worktree at `<repo>/.clawdparty/worktrees/session-<id>`
  on branch `clawd/session-<id>` (the frozen `sidecar-protocol` convention), records `base_sha` at run start,
  and tears down / resets a worktree. Rails owns worktree creation; the sidecar only uses it as `cwd`. Operates
  on the bind-mounted `/repo`, so it must produce a worktree whose absolute gitdir resolves in the sidecar
  container too (the cross-uid `safe.directory` already configured by `dev-docker-compose`).
- **`Runs::Start`** — the run-start service: enforce one-active-run (the DB partial index is the backstop;
  the service checks + races safely), require a clean worktree except on revise, create the worktree + record
  `base_sha`, create the `ai_run` (`queued`, `requested_by` = the requesting participant), and POST to the
  sidecar's `/runs` with `requested_by` sourced from `ai_runs.requested_by`. It does **not** emit `run_started`
  — per the frozen `sidecar-protocol` the **sidecar** emits that (stamping the requester as `actor`); Rails
  transitions `queued → running` when it ingests it. Encodes the **reject-severs-`claude_session_id`** rule's
  data side (only revise passes `claude_session_id`; a post-reject start does not resume).
- **`Runs::Finalize`** — moves a run to its terminal state from the run-lifecycle events the sidecar emits
  (`run_finished`→`completed_clean`/`awaiting_review`, `run_failed`→`failed`, `run_interrupted`→`awaiting_review`
  when the worktree is dirty), driven by ingest, not by polling.
- **`POST /api/sessions/:id/runs`** (start), **`POST /api/runs/:id/messages`** (follow-up), **`POST
  /api/runs/:id/interrupt`** — the client-facing run-control surface, each `SessionPolicy`-gated (run/interrupt
  = owner+editor), each forwarding to the sidecar over `SIDECAR_URL`. Status is derived from events, never a
  bespoke cable message.
- **A sidecar HTTP client** (`Sidecar::Client`) — the Rails→sidecar caller for `/runs`, `/runs/:id/messages`,
  `/runs/:id/interrupt`, targeting `SIDECAR_URL`, handling the frozen `202`/`200`/`409` responses.
- **Request specs** for the role matrix on run-control endpoints, the one-active-run rejection, the worktree
  convention, and the reject-no-resume / revise-resumes rule.

This change does **not** implement the sidecar runner (`sidecar-runner`), the diff/file APIs
(`file-and-diff-api`), the changeset approve/reject service (W3), or any UI. It is the Rails orchestration +
worktree + run-control surface only.

## Capabilities

### New Capabilities
- `worktree-management`: `Git::WorktreeManager` — Rails-owned creation of the session worktree at the frozen
  path/branch, `base_sha` recording at run start, reset/teardown, and the cross-container path/ownership
  guarantees that let the sidecar use the worktree as `cwd`.
- `run-lifecycle`: `Runs::Start` / `Runs::Finalize`, the nine-state transitions (W2 subset: queued → running →
  awaiting_review/completed_clean/failed/interrupted, plus revise→superseded), the one-active-run enforcement,
  and the reject-severs-`claude_session_id` data rule (only revise resumes).
- `run-control-api`: `POST /api/sessions/:id/runs`, `POST /api/runs/:id/messages`, `POST /api/runs/:id/interrupt`,
  each `SessionPolicy`-gated and forwarding to the sidecar via `Sidecar::Client` over `SIDECAR_URL`; status
  derived from events.

### Modified Capabilities
<!-- None as OpenSpec deltas: rails-foundation is not yet archived into openspec/specs/, so there is no base
     to attach a delta to. This change ADDS orchestration on top of the W1 data model + Events::Append +
     SessionPolicy, which it consumes without changing their requirements. -->

## Impact

- **New code:** `api/app/services/git/worktree_manager.rb`, `api/app/services/runs/start.rb`,
  `api/app/services/runs/finalize.rb`, `api/app/services/sidecar/client.rb`, the run-control controllers under
  the `/api` scope, routes, and request/service specs.
- **Consumes (does not modify):** the W1 `ai_runs` model + one-active-run partial index + nine-state enum,
  `Events::Append` (run lifecycle events committed atomically), `SessionPolicy` (run/interrupt gating), the
  frozen `sidecar-protocol` (`POST /runs` fields incl. `requested_by`, `permission_mode`, `allowed_tools`, the
  worktree convention, `base_sha`, `SIDECAR_URL`), and the `dev-docker-compose` `/repo` mount + git
  `safe.directory`.
- **Cross-stream:** pairs with `sidecar-runner` (the sidecar half of `POST /runs`); the run-lifecycle events it
  finalizes on are produced by that runner. Until the runner lands, run-start is exercisable against the W1
  `501` stub + a fake/sidecar test double, and `Runs::Finalize` is exercisable by feeding lifecycle events
  through ingest (the fake-Claude replay path).
- **No SDK-spike dependency.** Run lifecycle, worktrees, and HTTP are protocol-level; payloads are opaque here.
- **Dependencies:** `freeze-interface-contracts`, `rails-foundation`, `dev-docker-compose` (the `/repo` mount +
  cross-uid `safe.directory`). Sequenced after the spike is unnecessary; may proceed in parallel with it.
