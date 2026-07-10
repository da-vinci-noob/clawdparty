## Why

The diff-review + approve/reject flow is one of the five never-cut MVP pieces, but it was deferred and never
built. Today: no web component ever fetches `GET /api/runs/:id/diff` or renders a diff (the "W3 review screen"
is a stub comment); review runs never reach `awaiting_review` because nothing emits `changeset_ready`, so a
`run_finished` review run always finalizes `completed_clean`; and there are no approve/reject endpoints. Net
effect for the user: **the diff never shows for any role**, and a review session can't be approved or rejected.
The backend diff endpoint exists and is correctly `:view`-gated (all roles) — the gap is the trigger + the UI +
the approve/reject loop.

## What Changes

- **Review runs reach `awaiting_review` from real worktree dirtiness.** `Runs::Finalize#finished_status` for a
  `review` run enters `awaiting_review` when the run's worktree is dirty at finish (mirroring the existing
  `run_interrupted` path), instead of requiring a `changeset_ready` event that nothing produces. On that
  transition Rails appends a `changeset_ready` event (Contract-1) so the feed marks the reviewable changeset.
- **Owner approve/reject endpoints + services.** `POST /api/runs/:id/approve` (owner) → status `approved`,
  appends `changeset_approved`. `POST /api/runs/:id/reject` (owner) → `git reset --hard HEAD && git clean -fd`
  in the worktree, status `rejected`, appends `changeset_rejected`. Reject severs `claude_session_id` chaining
  (already encoded in `Runs::Start`); revise resumes it and is already implemented as `Runs::Start` mode
  `revise` — the web now sends `revise` for a follow-up while `awaiting_review`.
- **Web diff viewer.** A diff component fetches `GET /api/runs/:id/diff` when the current run is
  `awaiting_review` and renders the file list + unified patch with `react-diff-view`, for ALL roles
  (view-gated). Owner-only Approve / Reject controls (gated by `can("approve")`), and a Revise affordance
  (owner+editor) that submits a follow-up as `mode: "revise"`.
- **Feed rendering** for `changeset_ready` / `changeset_approved` / `changeset_rejected`.

## Capabilities

### New Capabilities
- `diff-review-approve`: the review lifecycle after a run finishes dirty — `awaiting_review` on worktree
  dirtiness + a `changeset_ready` event, the web diff viewer (fetch + render `GET /api/runs/:id/diff` for all
  roles), owner approve/reject (with `git reset` on reject) emitting `changeset_approved`/`changeset_rejected`,
  and the revise follow-up path.

### Modified Capabilities
<!-- None as OpenSpec deltas: run-orchestration (run lifecycle, Runs::Start revise/reject-severs, Git::Diff,
     the :view-gated diff endpoint) and the event taxonomy (changeset_* already defined) are not archived into
     openspec/specs/. This wires up the deferred review loop on top of them; the changeset_* event NAMES and
     the diff endpoint already exist (Contract-1 frozen), so no envelope/taxonomy change. -->

## Impact

- **api:** `Runs::Finalize` (review finish → `awaiting_review` on dirty + append `changeset_ready`); new
  `Runs::Approve` / `Runs::Reject` service POROs; `RunsController#approve`/`#reject` (owner-gated via
  `SessionPolicy` `approve`/`reject`, already in the matrix); routes (runs member `approve`, `reject`);
  `Git::WorktreeManager#reset_hard!` (already exists) called on reject. Request/service specs.
- **web:** a `diff_view` component (fetch `GET /api/runs/:id/diff`, render with `react-diff-view`), approve/
  reject controls (owner), revise via the composer (`mode: "revise"` when `awaiting_review`), feed rows for
  `changeset_*`. Vitest + MSW.
- **contract:** neutral — `changeset_ready`/`changeset_approved`/`changeset_rejected` are already in the frozen
  taxonomy; the diff REST endpoint already exists. No envelope/status/protocol change (`awaiting_review`,
  `approved`, `rejected` are existing `AiRun` statuses).
- **Consumes (does not modify):** run-orchestration (`Runs::Start` revise + reject-severs, `Git::Diff`),
  per-repo-review-worktree (the worktree the diff is computed against), session-create/roles.
- **Out of scope:** merging an approved session branch back to the repo's default branch; multi-changeset /
  per-file approval; conflict resolution; a dedicated diff *tab* (the diff renders in the session view).
