## Context

clawdparty is built git-first: `Runs::Start` calls `Git::WorktreeManager#ensure_worktree!` (per-session worktree
on branch `clawd/session-<id>`), records `base_sha`, and the product's spine is changeset review
(diff → approve=commit / reject=`git reset --hard`). This is correct for "guide Claude editing a repo," but it
hard-requires a git repository at the target and forces every interaction through the approval gate. A user who
just wants Claude running live in a directory (git or not) can't: a non-git target raises `GitError` (now a 422).

This change adds a **second run mode on the session**. `review` (default) is exactly today's flow. `chat` runs
Claude directly in a working directory with no worktree, no `base_sha`, no diff, no approval — reusing the
identical Contract-1 event stream. The sidecar is already `cwd`-driven (it runs `query({ cwd })`), so chat mode
is almost entirely a Rails + web concern: hand the sidecar a plain directory instead of a worktree path.

## Goals / Non-Goals

**Goals:**
- A session can be created in `chat` mode and run Claude live in any directory under the mounted repo root,
  git or not, with no worktree/diff/approval.
- `review` mode is byte-for-byte unchanged.
- Contract-neutral: no new event types, no envelope change, no new run status (chat reuses `completed_clean`).
- Chat runs always reach a terminal status (never wedge the one-active-run lock).

**Non-Goals:**
- Running outside the bind-mounted repo root (the sidecar container can only `cwd` into mounted paths).
- Converting a session between modes after creation (a session is one mode for life).
- Multi-directory sessions, or a diff/approval flow for chat runs.
- The sidecar-emits-`run_failed`-on-error robustness fix — related (both modes need runs to finalize) but a
  separate change; chat mode depends on it only insofar as any run must terminate.

## Decisions

**1. Mode lives on the Session, not the AiRun.** The worktree is per-session; whether one exists is the whole
distinction. `sessions.mode` (`review` | `chat`, default `review`, not null), chosen at create. *Why:* a
session is a stable context (one directory, one mode); per-run modes would fragment the worktree lifecycle for
no MVP benefit. *Alternative considered:* per-run mode — rejected (a session's worktree can't be half-there).

**2. Chat pins `cwd` to a containment-checked working directory; no worktree, no base_sha.** `Runs::Start`
branches: `chat` skips `ensure_worktree!`/`dirty?`, does not set `base_sha`, and passes the session's working
directory (reusing `sessions.repository_path`) as the sidecar `cwd`. The directory is realpath-contained within
the mounted repo root at create time (the same rule `RepoBrowser` uses to defeat `../`/symlink escape). *Why:*
the sidecar can only `cwd` into mounted paths, and an un-contained path is both broken and a traversal risk.

**3. Chat runs finalize to `completed_clean`, never `awaiting_review`.** `Runs::Finalize` for a `chat` run maps
`run_finished` → `completed_clean` and `run_interrupted` → `completed_clean` (there is no changeset to review).
`run_failed` → `failed` in both modes. *Why:* `awaiting_review` presupposes a diff; chat has none. Reusing
`completed_clean` avoids a new status (contract-neutral).

**4. The sidecar is unchanged.** It already receives `repo_path` and runs `query({ cwd: repo_path })`. Chat mode
simply sends the plain directory as `repo_path`. No sidecar code or protocol change. *Why:* keep the SDK-facing
seam untouched; the mode distinction is entirely Rails-side setup.

**5. Web hides the review-only surface for chat sessions.** The create form offers mode + working directory; a
`chat` session omits diff/approval affordances. Composer/interrupt/chat/activity feed are identical across modes
(they are event-driven and mode-agnostic). *Why:* the review UI is meaningless without a changeset.

## Risks / Trade-offs

- **Arbitrary `cwd` → traversal / running somewhere unintended.** → Realpath-containment of the working
  directory within the mounted repo root at create (Decision 2) + a spec asserting an escaping path is refused.
- **A chat run that errors could wedge the one-active-run lock** (no terminal event → stuck `running`). →
  This is the general "sidecar must emit `run_failed` on error" robustness gap (tracked separately); chat mode
  does not introduce it but shares the dependency. A chat run that finishes normally finalizes `completed_clean`.
- **`repository_path` now serves two meanings** (git repo in review / plain dir in chat). → Acceptable: it is
  "the session's working directory" in both; mode disambiguates. Documented on the model.
- **Someone expects a diff on a chat session.** → The web omits the diff/approval UI for chat; the diff API
  simply isn't offered there. Clear from the session's mode.

## Migration Plan

Additive, low-risk. (1) Migration: add `sessions.mode` (default `'review'`, not null) — existing sessions
stay `review`. (2) `Session` model enum + create endpoint/validation. (3) `Runs::Start`/`Runs::Finalize`
branch on mode. (4) Web create-form mode toggle + directory; hide review UI for chat. No backfill (all existing
sessions are `review`). Rollback = drop the column + revert the branches; no persisted run data depends on it
beyond the mode flag.

## Open Questions

- Default working directory for chat when none is given: fall back to the mounted repo root (`/repo`)? Proposed
  yes (a sensible default; still contained). Finalized at implementation.
- Whether the read-only file browser (`file-and-diff-api`) should still be offered for a chat session (it can
  list/read files even with no worktree). Proposed: yes, read-only browse is harmless and useful; only the
  diff + approval are omitted.
