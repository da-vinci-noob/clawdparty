## ADDED Requirements

### Requirement: A review run that finishes with a dirty worktree enters awaiting_review

When a `review`-mode run finishes, the system SHALL transition it to `awaiting_review` if its worktree has
uncommitted changes, and to `completed_clean` if the worktree is clean — derived from the actual worktree
state, NOT from any upstream event. On entering `awaiting_review` the system SHALL append a `changeset_ready`
event so the activity feed marks the reviewable changeset. A `chat`-mode run SHALL always finish
`completed_clean` (no changeset).

#### Scenario: A dirty review run becomes awaiting_review with a changeset_ready event

- **WHEN** a review run finishes and its worktree has uncommitted changes
- **THEN** the run's status is `awaiting_review` and a `changeset_ready` event is recorded for the run

#### Scenario: A clean review run completes without review

- **WHEN** a review run finishes and its worktree has no uncommitted changes
- **THEN** the run's status is `completed_clean` and no `changeset_ready` event is recorded

### Requirement: The changed diff is viewable by every role over REST

The run's diff SHALL be served by `GET /api/runs/:id/diff` to any participant (all roles may view), returning
the changed files and the unified patch, computed against the run's `base_sha` with untracked files counted.
The diff SHALL NOT be delivered over the cable channel.

#### Scenario: A reviewer views the diff

- **WHEN** a participant with the `reviewer` role requests the diff of an `awaiting_review` run
- **THEN** the response contains the changed files and the unified patch (not an authorization error)

#### Scenario: The web surfaces the diff when a run is awaiting_review

- **WHEN** the current run is `awaiting_review`
- **THEN** the session view fetches `GET /api/runs/:id/diff` and renders the file list + patch for the viewing
  participant, regardless of role

### Requirement: An owner can approve a reviewed changeset

`POST /api/runs/:id/approve` SHALL let an **owner** approve an `awaiting_review` run: the run becomes `approved`
and a `changeset_approved` event is recorded. A non-owner SHALL be refused `403`; a non-participant/unknown run
SHALL be refused `404`; a run that is not `awaiting_review` SHALL be refused with a client error. Approve keeps
the worktree as-is (no revert).

#### Scenario: Owner approves an awaiting_review run

- **WHEN** an owner approves a run that is `awaiting_review`
- **THEN** the run becomes `approved`, a `changeset_approved` event is recorded, and the worktree is unchanged

#### Scenario: A non-owner cannot approve

- **WHEN** an editor/reviewer/viewer attempts to approve
- **THEN** the request is refused `403` and the run status is unchanged

### Requirement: An owner can reject a reviewed changeset, reverting the worktree

`POST /api/runs/:id/reject` SHALL let an **owner** reject an `awaiting_review` run: the worktree is reverted
(`git reset --hard HEAD` then `git clean -fd`), the run becomes `rejected`, and a `changeset_rejected` event is
recorded. A non-owner SHALL be refused `403`; a non-participant/unknown run SHALL be refused `404`; a run that
is not `awaiting_review` SHALL be refused with a client error. After a reject, the next run SHALL NOT resume the
rejected run's Claude session (chaining is severed); only a revise resumes.

#### Scenario: Owner rejects an awaiting_review run

- **WHEN** an owner rejects a run that is `awaiting_review`
- **THEN** the worktree is reset to a clean HEAD, the run becomes `rejected`, and a `changeset_rejected` event
  is recorded

#### Scenario: A fresh run after a reject does not resume the rejected session

- **WHEN** a new (non-revise) run starts after the most recent run was `rejected`
- **THEN** it begins a new Claude session (no resume of the rejected run's `claude_session_id`)

### Requirement: The web presents role-appropriate review controls

The session view SHALL show Approve and Reject controls only to an owner (the `approve`/`reject` capability),
and a Revise affordance to participants who can run (owner + editor) that submits a follow-up as `mode:
"revise"` while the current run is `awaiting_review`. The diff itself SHALL be visible to all roles; only the
mutating controls are role-gated (the server enforces the roles; the client only hides buttons).

#### Scenario: Owner sees approve/reject; a viewer does not

- **WHEN** the current run is `awaiting_review`
- **THEN** an owner sees Approve and Reject controls, while a viewer sees the diff but no approve/reject/revise
  controls

#### Scenario: A revise follow-up resumes the session on the dirty tree

- **WHEN** an owner or editor submits a follow-up while the run is `awaiting_review`
- **THEN** the follow-up is sent as `mode: "revise"`, superseding the prior run and continuing on the existing
  (un-reverted) worktree
