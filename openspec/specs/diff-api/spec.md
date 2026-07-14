# diff-api Specification

## Purpose
TBD - created by archiving change file-and-diff-api. Update Purpose after archive.
## Requirements
### Requirement: Run diff is computed with intent-to-add and served over REST only

`GET /api/runs/:id/diff` SHALL return the run's diff computed in the session worktree using `git add
--intent-to-add -A` followed by `git diff HEAD` (numstat for stats + the per-file patch), so that **untracked
files Claude created are counted and shown**. The diff SHALL be served over REST only and SHALL NEVER be
broadcast over cable, per the frozen `http-api-contract`. The endpoint SHALL be `SessionPolicy`-gated to the
`view` action.

#### Scenario: A newly-created untracked file appears in the diff

- **WHEN** a run created a new (untracked) file and the diff is requested
- **THEN** `git add --intent-to-add -A` causes the new file to be counted, so it appears in the diff numstat and
  patch

#### Scenario: Diff is REST-only

- **WHEN** a client needs a run's diff
- **THEN** it fetches `GET /api/runs/:id/diff` over REST, and no diff is delivered over cable

#### Scenario: View role may read the diff

- **WHEN** any participant (owner/editor/reviewer/viewer) requests the run diff
- **THEN** `SessionPolicy` permits it (the `view` action is allowed for all roles)

### Requirement: Intent-to-add does not corrupt the worktree content state

Computing the diff with `git add --intent-to-add -A` SHALL stage only the intent (the path), not file content,
so the diff computation does not alter the worktree's file content state and any staging is cleared by the
worktree reset (`worktree-management`) on reject.

#### Scenario: Diff computation leaves file content unchanged

- **WHEN** the diff is computed via `--intent-to-add`
- **THEN** the worktree's file contents are unchanged by the computation (only path-intent is staged), so
  repeated diff reads are consistent

### Requirement: Cross-session diff access is refused with 404

A request for the diff of a run belonging to a session the requester is not a participant of SHALL respond `404`
(not `403`), consistent with the anti-enumeration convention.

#### Scenario: Non-participant diff access is 404

- **WHEN** a participant of session A requests a diff for a run in session B
- **THEN** the request is refused `404`, not confirming the run/session exists

