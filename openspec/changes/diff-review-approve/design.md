## Context

The backend already has the pieces the review flow needs but never connects them: `GET /api/runs/:id/diff`
(`:view`-gated, all roles) computes the diff via `Git::Diff` (`git add --intent-to-add -A` then `git diff HEAD`,
untracked counted); `Git::WorktreeManager#reset_hard!` (`git reset --hard HEAD && git clean -fd`) exists;
`AiRun::STATUSES` includes `awaiting_review`/`approved`/`rejected`; `SessionPolicy` grants `approve`/`reject` to
owner; `Runs::Start` already implements `revise` (resume the session, keep the dirty tree, supersede the prior
run) and reject-severs-chaining. The event taxonomy already defines `changeset_ready`/`_approved`/`_rejected`.
What's missing: the transition INTO `awaiting_review`, the approve/reject actions, and the entire web diff UI.

`Runs::Finalize#finished_status` gates `awaiting_review` on the existence of a `changeset_ready` event — but
nothing emits one, so review runs always finalize `completed_clean`. The `run_interrupted` path already derives
the review state from actual worktree dirtiness (`worktree_dirty?`); the finish path should do the same.

## Goals / Non-Goals

**Goals:**
- A review run that leaves the worktree dirty ends in `awaiting_review` and the diff is visible to every role.
- Owner can approve (keep) or reject (revert via `git reset --hard`); either records a Contract-1 event.
- Revise (resume + keep the dirty tree) is reachable from the UI while `awaiting_review`.
- The diff renders from the existing REST endpoint; no diffs over cable (invariant).

**Non-Goals:**
- Merging an approved branch to the repo's default branch, or pushing anywhere.
- Per-file / partial approval, conflict resolution, or a multi-changeset history.
- Changing the frozen event taxonomy, envelope, run-status set, or the diff endpoint shape.

## Decisions

**1. Derive `awaiting_review` from worktree dirtiness, and emit `changeset_ready` on the transition.** In
`Runs::Finalize`, a `review` `run_finished` becomes `awaiting_review` iff `Git::WorktreeManager.new(session).dirty?`
(mirroring `interrupted_status`), else `completed_clean`. When it enters `awaiting_review`, append a
`changeset_ready` event (system actor) in the same flow so the feed marks it and clients can react. *Why derive,
not require an emitted event:* nothing produces `changeset_ready` upstream, and dirtiness IS the reviewable
signal — the same signal the interrupt path already trusts. Rails owns git, so Rails is the right place to
decide. The append reuses the next per-run seq (Rails owns seq once the sidecar's run has finished).

**2. Approve / reject are Rails service POROs behind owner-gated endpoints.** `Runs::Approve` sets status
`approved` and appends `changeset_approved`; `Runs::Reject` runs `WorktreeManager#reset_hard!` then sets
`rejected` and appends `changeset_rejected`. Both require the run to be `awaiting_review` (else a clean 409/422).
`POST /api/runs/:id/approve` and `.../reject` gate on `SessionPolicy` `approve`/`reject` (owner). *Why services:*
matches the `Runs::Start`/`Events::Append` PORO style; the mutation + event append happen in one transaction
(`Events::Append`).

**3. Reject-severs / revise-resumes already hold; wire revise in the UI.** `Runs::Start` already returns no
resume id after a `rejected` run and resumes otherwise, and `revise` supersedes the prior run + keeps the dirty
tree. The web sends `mode: "revise"` for a follow-up submitted while the current run is `awaiting_review`
(otherwise a normal fresh run). No new backend logic for revise.

**4. The diff viewer fetches REST on `awaiting_review`, renders with `react-diff-view`, shows for all roles.**
A `diff_view` component keys off the current run's status: when `awaiting_review`, it `fetch`es `GET
/api/runs/:id/diff` (credentials include) and renders the file list + the unified `patch` via `react-diff-view`
(parse-diff). It renders for every role (the endpoint is `:view`-gated). Approve/Reject buttons render only when
`can("approve")` (owner); a Revise input (owner+editor, `can("run")`) submits `mode: "revise"`. *Why REST not
cable:* the diff-over-REST invariant; the patch can be large.

**5. Feed rows for the changeset events.** `changeset_ready`/`_approved`/`_rejected` get compact feed rows
(status markers), consistent with the existing per-type feed rendering.

## Risks / Trade-offs

- **A review run that finishes clean shows no diff** — correct (nothing to review), but if Claude's edits were
  committed inside the worktree the tree is clean; `Git::Diff` compares against `base_sha`, so committed changes
  still diff. `dirty?` (uncommitted) is the awaiting_review trigger; a run that only commits would look clean to
  `dirty?`. → Acceptable for MVP (Claude edits are uncommitted in practice); noted.
- **Reject is destructive** (`git reset --hard && git clean -fd`). → Owner-only, requires `awaiting_review`,
  records `changeset_rejected`; the reverted tree + severed session chain match the documented invariant.
- **Large patches** → the endpoint already returns the full patch; the viewer renders it as-is for MVP
  (virtualization is a later concern). `Git::Diff` has no size cap today — a note, not solved here.
- **Concurrent approve/reject** → guarded by requiring `awaiting_review`; a second action finds a non-review
  status and is refused (409/422). One active run per session still holds.

## Migration Plan

Additive; no schema change (all statuses + event types + the diff endpoint exist). Order: (1) `Runs::Finalize`
review-dirty → `awaiting_review` + append `changeset_ready` (+ spec); (2) `Runs::Approve`/`Runs::Reject` +
controller actions + routes + owner gating (+ request/service specs); (3) web `diff_view` (fetch + render) wired
into the session page + approve/reject controls + revise-in-composer + `changeset_*` feed rows (+ Vitest/MSW);
(4) live verify: a review run that edits files → `awaiting_review`, diff shows for a reviewer, owner approve →
`approved`; a second run, reject → tree reverted + `rejected`; revise resumes. Rollback = revert the finalize
change + the new endpoints + the UI; nothing persisted depends on it beyond existing columns/events.

## Open Questions

- Whether `changeset_ready` should also be emitted for the `run_interrupted`→`awaiting_review` path (today it
  transitions without the event). Proposed: emit it there too for consistency, so the feed always marks an
  entered review. Finalize at implementation.
