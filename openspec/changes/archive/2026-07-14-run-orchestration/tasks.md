## 1. Git::WorktreeManager (worktree-management)

- [x] 1.1 Implement `api/app/services/git/worktree_manager.rb`: `git worktree add <repo>/.clawdparty/worktrees/session-<id> -b clawd/session-<id>` (reuse if it exists), operating on `/repo`
- [x] 1.2 Record `base_sha` (`git rev-parse HEAD` of the worktree) onto the `ai_run` at start
- [x] 1.3 Implement reset (`git reset --hard HEAD && git clean -fd` in the worktree) + teardown operations
- [x] 1.4 Spec: a Rails-created worktree resolves when git is run in it (assert no dubious-ownership failure); reset returns a clean tree; base_sha captured

## 2. Runs::Start (run-lifecycle)

- [x] 2.1 Implement `api/app/services/runs/start.rb`: require a clean worktree (except revise), create worktree + record base_sha, create the `ai_run` (`queued`, `requested_by` = requester). Do NOT emit `run_started` — the sidecar emits it (frozen sidecar-protocol); Rails transitions `queued → running` on ingest (see 3.1)
- [x] 2.2 Enforce one-active-run via the DB partial index (rescue `RecordNotUnique` → surface `409`); confirm a terminal prior run does not block
- [x] 2.3 Build the `/runs` payload: `requested_by` from `ai_runs.requested_by`, `repo_path` = worktree, `permission_mode: acceptEdits`, `allowed_tools` whitelist; call `Sidecar::Client`
- [x] 2.4 Encode reject-no-resume / revise-resumes: on `revise` supersede the prior run + keep dirty tree + pass `claude_session_id`; on a fresh post-reject start pass NO `claude_session_id`
- [x] 2.5 Specs: one-active-run race → exactly one wins (`409`); revise passes `claude_session_id`, fresh-after-reject does not; `/runs` payload shape asserted against a stubbed `Sidecar::Client`

## 3. Runs::Finalize (run-lifecycle)

- [x] 3.1 Implement `api/app/services/runs/finalize.rb`: transition from ingested lifecycle events — `run_started` → `running` (queued→running); `run_finished` → `completed_clean`/`awaiting_review`, `run_failed` → `failed`, `run_interrupted` → `awaiting_review` (dirty) / `completed_clean` (clean)
- [x] 3.2 Invoke `Runs::Finalize` from the event-ingest path (driven by events, not polling); confirm Rails — not the sidecar — owns every transition
- [x] 3.3 Specs: feed each lifecycle event (incl. `run_started`) through `Events::Ingest` and assert the resulting transition (no live runner needed)

## 4. Sidecar::Client + run-control API (run-control-api)

- [x] 4.1 Implement `api/app/services/sidecar/client.rb`: `POST /runs` / `/runs/:id/messages` / `/runs/:id/interrupt` against `SIDECAR_URL` (no hard-coded host); map `202`/`200`/`409`/`404`; injectable for tests
- [x] 4.2 Implement run-control controllers under `/api`: `POST /sessions/:id/runs`, `POST /runs/:id/messages`, `POST /runs/:id/interrupt`; each `SessionPolicy`-gated (run/interrupt = owner+editor); routes
- [x] 4.3 Status derives from events — introduce NO bespoke run-status cable message
- [x] 4.4 Run-start is async: respond after the sidecar `202`, do not block on completion
- [x] 4.5 Request specs: role matrix (reviewer/viewer denied `403`, non-participant `404`, owner/editor allowed); `409` surfaced on active-run conflict; client targets `SIDECAR_URL`

## 5. Validation

- [x] 5.1 Run `openspec validate run-orchestration --type change --strict` and confirm valid
- [x] 5.2 Confirm the `api` suite (RuboCop + RSpec) stays green, including the new orchestration/worktree/control specs (run via `bin/rspec`)
- [x] 5.3 Integration check against the live stack: a Rails-created worktree is usable from the sidecar container (cross-uid), and `Runs::Start` posts the correct `/runs` payload (stub or real sidecar)
