## Context

`Git::WorktreeManager` was written when there was one target repo bind-mounted at `/repo`, so it rooted the
per-session worktree at `repo_root` (`/repo`) and ran `git -C /repo worktree add`. The `directory-picker` +
`no-git-chat-mode` changes made the working directory selectable per session (`session.repository_path`) and
allowed the mount to point at a PARENT of many repos so the picker can browse them. Chat mode honors the
selection (it `cwd`s into `repository_path`), but review mode still roots the worktree at `repo_root`. When
`/repo` is a parent folder (not itself a git repo), `git -C /repo worktree add` fails → the 422 the user hit;
and even for a single-repo mount, review can't target a subdir repo.

`repository_path` is stored differently per mode today: chat contains+resolves it to an absolute path under the
root; review keeps the raw value (`SessionsController#working_directory` returns `given` for non-chat). The
worktree needs a valid absolute git-repo path, so review must resolve it the same way chat does.

## Goals / Non-Goals

**Goals:**
- A review session runs its worktree against the repo the user picked (`repository_path`), so diff/approve work
  on any repo the picker can reach.
- One containment rule that accepts both a relative (to root) and an absolute-under-root path.
- `repository_path` stored consistently (absolute, contained) for both modes.
- Keep the worktree working files out of the user's real repos (centralized under the mount root).

**Non-Goals:**
- Cleaning up the `clawd/session-<id>` branch/worktree registration left in the selected repo after a session
  ends (a later housekeeping change).
- Merging a session branch back to the repo's default branch.
- Changing the sidecar protocol, event taxonomy, or run-status model.
- Supporting repos outside the mounted root (the container can only see mounted paths).

## Decisions

**1. Root the worktree in the selected repo; keep the worktree path centralized.** `Git::WorktreeManager`
computes `repo_dir = session.repository_path.presence || repo_root` and runs `git -C repo_dir worktree add -b
clawd/session-<id> <worktree_path> HEAD`. `worktree_path` stays `repo_root/.clawdparty/worktrees/session-<id>`
(centralized, writable, out of the user's repos). *Why the git base = the selected repo:* that is the repo the
review is about. *Why centralize the worktree path:* it avoids littering the user's real repos with worktree
working trees; only a branch ref + a worktree registration land in the selected repo (inherent to `git
worktree`). `base_sha`, `dirty?`, and `reset_hard!` already operate on `worktree_path` and are unaffected.

**2. Contain + resolve `repository_path` for both modes.** `SessionsController#working_directory` uses the
shared containment helper for review as well as chat (default: the repo root when blank). So
`repository_path` is always an absolute path under `/repo` (or nil), which is exactly what the WorktreeManager
git base needs. *Why:* the raw-passthrough for review was only safe when review ignored `repository_path`;
now that review USES it, it must be a validated absolute path.

**3. Containment resolves relative OR absolute-under-root via `File.expand_path(path, root)`.** `RepoPaths.contain!`
replaces `File.expand_path(File.join(root, path))` with `File.expand_path(path, real_root)`: `File.expand_path`
uses the base dir only when the first arg is relative, so `'core'` → `/repo/core` and `/repo/core` →
`/repo/core` (no double-prefix), then realpath + the containment check. *Why:* the picker/update may send
either form, and the old `File.join` turned an absolute input into `/repo/repo/core`.

**4. A non-git selection remains a clean 422.** If `repo_dir` is not a git repo, `git worktree add` fails →
`GitError` → the controller's existing 422. The picker's `is_git_repo` flag warns before selection; this is the
backstop. No new error type.

**5. Blank `repository_path` falls back to `repo_root`.** Old/less-specific review sessions (no picked repo)
still root at `/repo`; that only succeeds if `/repo` itself is a git repo (single-repo mounts), matching
today's behavior. New sessions created via the picker always carry a repo.

## Risks / Trade-offs

- **Branch/worktree footprint in the user's real repos.** `git worktree add` creates a `clawd/session-<id>`
  branch + a `.git/worktrees/…` registration in the selected repo. → Accepted for MVP; centralizing the
  worktree working files limits it to a branch ref + registration. Cleanup on session end is a noted Non-Goal.
- **Two sessions targeting the same repo.** Each session gets a distinct branch/worktree (`session-<id>`), so
  they don't collide; the one-active-run invariant is per session, not per repo. Concurrent worktrees on one
  repo are a supported git feature.
- **Changing review-mode `repository_path` storage** could affect an existing spec that posted a raw value and
  expected passthrough. → `File.expand_path`-based containment keeps an already-in-root absolute path
  unchanged (e.g. `'/repo'` → `'/repo'`), so the existing "stores repository_path when given" behavior holds;
  the escape case now 422s (desired).
- **Dirty/uncommitted state in the selected repo.** The worktree is created from `HEAD`; the user's working
  changes in the real checkout are not included (a worktree is a clean checkout of HEAD). This matches
  today's semantics for `/repo`; call it out so it is not surprising.

## Migration Plan

Additive/behavioral; no schema change. Order: (1) `RepoPaths.contain!` → `File.expand_path(path, root)` (keep
existing repo_browser/sessions specs green); (2) contain review-mode `working_directory`; (3)
`Git::WorktreeManager` git base = `repository_path || repo_root`, worktree path centralized; (4) specs
(worktree_manager, sessions, runs/start); (5) live verify: pick a git repo in review mode, start a run, confirm
the worktree is created from that repo and diff works; a non-git pick 422s; a `../` escape is refused. Rollback
= revert the WorktreeManager base + the containment/controller changes; nothing persisted depends on it beyond
the existing `repository_path`.

## Open Questions

- Whether to `git worktree remove` + delete the `clawd/session-<id>` branch when a session is archived
  (housekeeping). Proposed: out of scope here; revisit if branch buildup in real repos becomes a problem.
