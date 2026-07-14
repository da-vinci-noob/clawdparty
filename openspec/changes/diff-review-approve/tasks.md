> **Contract-neutral.** Wires up the deferred review loop. `changeset_ready`/`_approved`/`_rejected` are
> already in the frozen taxonomy; `awaiting_review`/`approved`/`rejected` are existing AiRun statuses; the diff
> endpoint + `Git::Diff` + `WorktreeManager#reset_hard!` + `Runs::Start` revise/reject-severs already exist. No
> migration, no envelope/status/protocol change.

## 1. Enter awaiting_review on a dirty review finish (api)

- [x] 1.1 `Runs::Finalize#finished_status` — review run: `worktree_dirty?(run) ? 'awaiting_review' : 'completed_clean'` (mirror `interrupted_status`); drop the `changeset_ready?`-event gate that nothing satisfies
- [x] 1.2 On entering `awaiting_review` (from finish OR interrupt), append a `changeset_ready` event (system actor, next per-run seq) via `Events::Append`
- [x] 1.3 Specs: dirty review `run_finished` → `awaiting_review` + a `changeset_ready` event exists; clean → `completed_clean` + no event; chat → always `completed_clean` (update `finalize_spec` incl. the existing "no changeset → completed_clean" case which changes meaning)

## 2. Approve / reject services + endpoints (api)

- [x] 2.1 `Runs::Approve` — require `awaiting_review`; set `approved`; append `changeset_approved` (one txn via `Events::Append`); record `reviewed_by`
- [x] 2.2 `Runs::Reject` — require `awaiting_review`; `Git::WorktreeManager#reset_hard!`; set `rejected`; append `changeset_rejected`; record `reviewed_by`
- [x] 2.3 `RunsController#approve` / `#reject` — owner-gated (`authorize!(:approve|:reject, run.session)`); non-participant/unknown → 404; non-owner → 403; not-awaiting_review → 409/422; routes: runs member `post :approve`, `post :reject`
- [x] 2.4 Request specs: owner approve → approved + event; owner reject → tree reverted + rejected + event; non-owner 403; wrong-state refused; + `runs/start_spec` already covers reject-severs (verify still green)

## 3. Web diff viewer + review controls

- [x] 3.1 `components/diff_view.tsx` — when the current run is `awaiting_review`, fetch `GET /api/runs/:id/diff` (credentials include), render file list + unified `patch` with `react-diff-view` (parse-diff); loading/empty/error states; visible to ALL roles
- [x] 3.2 Approve / Reject controls — owner only (`can("approve")`); POST approve/reject; on success the run leaves `awaiting_review` (event stream updates the store)
- [x] 3.3 Revise — while `awaiting_review`, the composer submits a follow-up as `mode: "revise"` for participants who `can("run")`; a normal (non-review) send stays `mode: "fresh"`
- [x] 3.4 Feed rows for `changeset_ready` / `changeset_approved` / `changeset_rejected` in `activity_feed`
- [x] 3.5 Wire `<DiffView>` into `session_page.tsx`; Vitest + MSW: diff renders for a reviewer; owner sees approve/reject and a viewer does not; approve POSTs; reject POSTs; revise sends `mode: "revise"`; Biome + tsc clean

## 4. Validation

- [x] 4.1 `openspec validate diff-review-approve --type change --strict` passes
- [x] 4.2 All suites green: `api` (RSpec + RuboCop), `web` (Biome + tsc + Vitest); sidecar untouched
- [ ] 4.3 Live smoke: a review run that edits files → `awaiting_review`, diff shows for a reviewer; owner approve → `approved`; a second run → reject → worktree reverted + `rejected`; revise resumes on the dirty tree
