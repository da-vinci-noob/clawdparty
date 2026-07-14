## Context

`no-git-chat-mode` added `sessions.mode` + `repository_path` (the working directory) and a free-text field in
the create form; `SessionsController` already realpath-contains a chat directory within the mounted repo root
(the same rule `RepoBrowser#content` uses to defeat `../`/symlink escape). What's missing is discoverability:
the browser can't see the server filesystem, so users can't *pick* a folder — and there's no way to change a
session's directory after creation. This change adds a directory-listing endpoint the picker reads, a picker
UI for both modes, and an owner-gated session-update to change the directory.

The sidecar can only `cwd` into the bind-mounted `/repo` tree, so the pickable universe is exactly the repo
root and its subdirectories — the same trust boundary the file API already operates in.

## Goals / Non-Goals

**Goals:**
- Pick a working directory from the browser for BOTH review and chat sessions (navigate + select).
- Show whether each folder is a git repo (so review-mode picks a real repo; chat can pick anything).
- Change a session's working directory after creation (owner-only), applied to subsequent runs.
- One containment implementation, reused by the listing endpoint, the create path, and the update path.

**Non-Goals:**
- Browsing outside the mounted repo root, creating directories, or a full file manager.
- Changing a session's `mode` after creation, or moving an in-flight run's cwd.
- A live terminal `cd`; "change directory" is a session setting that the next run picks up.

## Decisions

**1. Listing endpoint returns immediate children only, containment-checked, git-flagged.** `GET
/api/directories?path=<relative>` resolves `path` against the repo root, realpath-contains it, and returns the
immediate subdirectories (name + relative path + `is_git_repo`). Immediate-children (not recursive) keeps
responses small and the UI a simple navigator. *Why containment:* the resolved path must stay within the repo
root — identical to the file API's rule; an escaping path is refused (404/422). *Why `is_git_repo`:* review
mode needs a git repo; the flag lets the UI guide the choice (and warn if a review pick isn't a repo).

**2. Extract the containment check into one shared helper.** Today the rule lives in `RepoBrowser#contained_path!`
and (duplicated) in `SessionsController#working_directory`. Extract a single `Git`/`RepoPaths.contain!(path)`
(or a module) used by the listing endpoint, create, and update. *Why:* three call sites must agree exactly;
one audited implementation is how the traversal guarantee stays true.

**3. `PATCH /api/sessions/:id` changes the working directory, owner-gated, next-run-applies.** Updates
`repository_path` (containment-checked) via `SessionPolicy` (owner — reuse `manage_invites`-style gating or a
`manage_session` action). It does not touch an active run (one-active-run holds); the new directory is used by
the next `Runs::Start`. *Why owner:* changing where Claude runs is a session-owner decision, like invites.

**4. The picker is one component, used in two places.** `directory_picker.tsx` fetches `GET /api/directories`,
renders the current path + parent/up + a list of subfolders (with the git marker), and calls back with the
chosen relative path. The create form embeds it (both modes); the session page opens it (owner) to `PATCH`.
*Why one component:* create and change-dir are the same interaction. It degrades to a text input if listing
fails (so a picker outage never blocks creating a session).

## Risks / Trade-offs

- **Traversal / symlink escape via the listing or update path.** → The single shared containment helper
  (Decision 2) applied at all three call sites + specs asserting `../`/absolute/symlink are refused.
- **A huge directory tree makes listing slow.** → Immediate-children only (Decision 1); no recursion. A very
  large single directory is still bounded by one `readdir`; pagination is a later note, not solved here.
- **Review session pointed at a non-git folder** → `Runs::Start` already raises a clean 422 (`GitError`); the
  picker's `is_git_repo` flag warns before the user picks, and the run-start error is the backstop.
- **Changing the directory mid-session surprises watchers.** → It applies only to the NEXT run and emits no
  retro-change; the session's activity feed is per-run, so a new run under a new dir is self-evident. (A
  `participant_joined`-style "directory changed" event could be added later if it needs to be visible.)
- **Symlinked repos / mount edge cases.** → realpath resolves symlinks before the containment check, so a
  symlink inside the root that points outside is refused; a symlink within the root resolves to its target and
  is allowed only if contained.

## Migration Plan

Additive, no schema change (`repository_path` already exists). Order: (1) extract the containment helper +
point `RepoBrowser`/`SessionsController` at it (no behavior change, covered by existing specs); (2)
`DirectoriesController#index` + route + specs; (3) `SessionsController#update` + route + owner gating + specs;
(4) web `directory_picker.tsx` + create-form integration + session-page change-dir control + tests; (5) live
verify. Rollback = revert the endpoints + UI; nothing persisted depends on it beyond the existing
`repository_path`.

## Open Questions

- Gating for the listing endpoint: proposed **any valid participant** (it exposes only the bind-mounted repo
  tree, the same boundary as the file API). Finalize at implementation; tightening to a role is trivial.
- Whether to surface a "directory changed" event in the feed for visibility. Proposed: not for MVP (applies to
  the next run, which is self-evident); revisit if users find it confusing.
