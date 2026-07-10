## Why

The directory picker lets you select any repo under the mounted root, but **review mode ignores the
selection**: `Git::WorktreeManager` roots its worktree at `Git::WorktreeManager.repo_root` (`/repo`, the mount
root). When the mount points at a parent folder of many repos (so the picker can browse them), `/repo` is not a
git repository, so every review run fails with `Could not prepare the session worktree — is the target repo a
git repository?`. Even with a single-repo mount, a review session can't target a subdirectory repo. Chat mode
already honors the picked directory (`cwd`); review mode must too, or the picker is misleading for review.

## What Changes

- **The review worktree is rooted in the session's SELECTED repo.** `Git::WorktreeManager` derives its git base
  from `session.repository_path` (the picked repo, e.g. `/repo/core`), falling back to `repo_root` (`/repo`)
  when blank. `git worktree add` runs against that repo; the worktree working files stay centralized under
  `repo_root/.clawdparty/worktrees/session-<id>` (out of the user's repos), and the `clawd/session-<id>` branch
  is created in the selected repo. `RepoBrowser` and `Git::Diff` already operate on `worktree_path`, so they
  follow automatically.
- **`repository_path` is stored as an absolute, contained path for BOTH modes.** Today chat contains+resolves
  the working directory but review stores the raw value. Both now resolve to an absolute path under `/repo`
  via the shared containment helper, so the worktree always gets a valid absolute git-repo path.
- **The shared containment helper accepts absolute-under-root paths too.** `RepoPaths.contain!` resolves the
  input with `File.expand_path(path, root)` (handles a relative path OR an absolute path already under the
  root) instead of blindly `File.join`-ing, which double-prefixed an absolute input.
- **A non-git pick fails clearly.** Selecting a folder that is not a git repo still raises the existing
  `GitError` → 422 (the picker's `is_git_repo` flag warns first); the message points at the selected folder.

## Capabilities

### New Capabilities
- `per-repo-review-worktree`: review-mode runs create their git worktree from the session's selected repository
  (`repository_path`) rather than the mount root, so the diff/approve flow works on any repo the picker can
  reach; plus the create/update + containment changes that store and validate an absolute in-root repo path.

### Modified Capabilities
<!-- None as OpenSpec deltas: the consumed capabilities (run-orchestration's worktree lifecycle, session-create /
     no-git-chat-mode's repository_path, directory-picker's containment + listing) are not archived into
     openspec/specs/. This re-roots the review worktree on repository_path and unifies containment on top of
     them; no frozen event/envelope/run-status contract changes. -->

## Impact

- **api:** `Git::WorktreeManager` (git base = `repository_path` || `repo_root`; worktree path stays centralized
  under `repo_root`), `RepoPaths.contain!` (`File.expand_path(path, root)` for relative-or-absolute inputs),
  `SessionsController#working_directory` (contain+resolve for review too, not just chat). Specs:
  `worktree_manager_spec` (worktree created from the selected repo; centralized path), `sessions_spec`
  (review-mode create stores an absolute contained path; escape → 422), `runs/start_spec` (review run uses the
  selected repo). No migration (`repository_path` already exists).
- **contract:** neutral — no event types, envelope, run-status, or sidecar-protocol change. The sidecar still
  receives `repo_path` (cwd) as before.
- **Consumes (does not modify):** `directory-picker` (listing + containment + change-dir), `no-git-chat-mode`
  (`mode` + `repository_path`), `run-orchestration` (worktree lifecycle, reject/revise), `session-create`.
- **Out of scope:** cleaning up `clawd/session-<id>` branches left in the selected repo after a session ends;
  merging a session branch back to the repo's default branch; browsing/worktrees outside the mounted root.
