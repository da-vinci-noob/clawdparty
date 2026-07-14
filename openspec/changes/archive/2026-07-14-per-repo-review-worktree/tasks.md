> **Contract-neutral, behavioral.** Re-roots the review worktree on `session.repository_path`, unifies working-
> directory containment across modes, and makes containment accept absolute-in-root paths. No event/envelope/
> run-status/sidecar-protocol change. No migration (`repository_path` exists).

## 1. Shared containment accepts relative or absolute-in-root (api)

- [x] 1.1 `RepoPaths.contain!` — resolve with `File.expand_path(path, real_root)` (relative → joined; absolute-in-root → unchanged) instead of `File.expand_path(File.join(root, path))`; keep realpath + the containment check + `Escape` on escape/unresolvable
- [x] 1.2 Confirm existing `files_spec` / `sessions_spec` / `directories_spec` stay green (no behavior change for relative inputs; absolute-in-root now handled)
- [x] 1.3 `repo_paths` unit coverage: `sub/dir` and `<root>/sub/dir` resolve identically; an absolute path outside the root is refused

## 2. Contain the working directory for both modes (api)

- [x] 2.1 `SessionsController#working_directory` — contain+resolve for `review` too (default: repo root when blank), via the shared helper; `#update` already contains (no change)
- [x] 2.2 `sessions_spec`: review-mode create stores the resolved absolute path; a `../` escape → 422; the existing "stores repository_path when given" case still passes (an in-root absolute path is unchanged)

## 3. Root the review worktree on the selected repo (api)

- [x] 3.1 `Git::WorktreeManager` — compute `repo_dir = session.repository_path.presence || repo_root`; run `git worktree add` with `dir: repo_dir` (git base = the selected repo); keep `worktree_path` centralized under `repo_root/.clawdparty/worktrees/session-<id>`
- [x] 3.2 Ensure `base_sha`, `dirty?`, `reset_hard!`, `worktree_exists?` still operate on `worktree_path` (unchanged); `Runs::Start#review_worktree!` needs no change (WorktreeManager derives the repo from the session)
- [x] 3.3 `worktree_manager_spec`: worktree created from a session whose `repository_path` is a git subdir repo (assert the branch/worktree exist and content comes from that repo); blank `repository_path` falls back to `repo_root`; a non-git `repository_path` raises `GitError`

## 4. Run-level coverage (api)

- [x] 4.1 `runs/start_spec`: a review run for a session with a git-repo `repository_path` prepares the worktree from that repo (no `GitError`); a review run whose `repository_path` is a non-git dir surfaces `GitError` (→ controller 422)

## 5. Validation

- [x] 5.1 `openspec validate per-repo-review-worktree --type change --strict` passes
- [x] 5.2 All suites green: `api` (RSpec + RuboCop); sidecar + web untouched
- [ ] 5.3 Live smoke: create a REVIEW session picking a git repo under the mount (e.g. `/repo/core`); start a run and confirm the worktree is created from that repo and the diff renders; a non-git pick 422s clearly; a `../` escape is refused; chat mode still works
