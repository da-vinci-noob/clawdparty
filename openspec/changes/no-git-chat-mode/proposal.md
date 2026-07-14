## Why

Every session today is git-backed: `Runs::Start` creates a per-session worktree and the whole product is
built around changeset review (base_sha → diff → approve=commit / reject=revert). That's the right model for
"guide Claude editing a repo," but it makes two things impossible: pointing a session at a plain directory
that isn't a git repo (you get a `GitError` → 422), and simply **chatting with / running Claude live in a
directory** without the heavyweight diff-and-approval loop. Users hit this immediately (create a session →
run → blocked because the target isn't a git repo). Add a lightweight second run mode so a session can run
Claude live in any directory, git or not, with no worktree and no approval gate.

## What Changes

- **Sessions gain a `mode`** — `review` (default; today's git-backed worktree + diff + approve/reject flow,
  unchanged) or **`chat`** (new). Chosen at create; a session is one mode for its lifetime.
- **`chat` mode runs Claude directly in the session's working directory** (`cwd`), git or not: **no worktree,
  no `base_sha`, no diff, no changeset, no approve/reject.** It reuses the exact same live event stream
  (`run_started`, `user_prompt`, `ai_text*`, `ai_thinking`, `tool_*`, `terminal_output`, `file_changed`,
  `run_finished`/`run_failed`/`run_interrupted`) — only the git/review scaffolding is skipped.
- **`Runs::Start`** branches on mode: `chat` skips `ensure_worktree!`/`dirty?`/`base_sha` and pins `cwd` to the
  session's working directory; `review` is unchanged. The one-active-run invariant still applies in both.
- **`Runs::Finalize`** for a `chat` run finalizes `run_finished` → `completed_clean` (never `awaiting_review` —
  there is no changeset); `run_interrupted` → `completed_clean` too (nothing to review).
- **Session create** accepts `mode` + a working directory (reusing `sessions.repository_path`), and the web
  landing "Create" form offers the mode + directory. The **working directory is containment-checked** to stay
  within the bind-mounted repo root (the sidecar can only `cwd` into mounted paths — same realpath-containment
  rule `RepoBrowser` already uses).
- **Web**: a `chat` session hides the diff/approval affordances (the file/diff surface stays available read-only
  where it makes sense; the approve/reject UI does not apply). The activity feed, prompt composer, interrupt,
  and chat are identical across modes.

This does **not** change the `review` mode, the event taxonomy/envelope, the sidecar's run protocol (it already
takes `cwd` — no sidecar code change), or add any run status (chat runs reuse `completed_clean`). It is
contract-neutral: no new event types, no envelope change.

## Capabilities

### New Capabilities
- `session-run-modes`: the `review` vs `chat` mode on a session — how it is chosen at create (with a
  containment-checked working directory), how `Runs::Start` drives each mode (git worktree + base_sha vs a
  plain pinned `cwd`), how `Runs::Finalize` finalizes a chat run (`completed_clean`, never `awaiting_review`),
  and that both modes share the identical live event stream and the one-active-run invariant.

### Modified Capabilities
<!-- None as OpenSpec deltas: the consumed capabilities (run-orchestration's Runs::Start/Finalize,
     worktree-management, session-create) are not archived into openspec/specs/, so there is no delta file to
     write. This ADDS a mode axis on top of them; `review` behavior is unchanged and this is contract-neutral
     (no event/envelope/endpoint-signature change — session create simply accepts an additional `mode` +
     working-directory field). -->

## Impact

- **Migration:** add `sessions.mode` (string/enum, default `'review'`, not null). Reuse the existing
  `sessions.repository_path` as the chat working directory.
- **api:** `Runs::Start` (branch on mode: chat skips worktree/base_sha, pins cwd), `Runs::Finalize` (chat →
  `completed_clean`, never `awaiting_review`), `SessionsController#create` (accept + validate `mode` +
  working directory with realpath containment under the repo root), `Session` model (`mode` enum). Request +
  service specs: a chat run starts with no worktree and no `base_sha`; a chat `run_finished` → `completed_clean`;
  a directory escaping the repo root is refused; `review` behavior unchanged.
- **sidecar:** none — it already runs `query()` in the `cwd` it is handed; chat mode just hands it a plain
  directory instead of a worktree path.
- **web:** the "Create" form gains a mode toggle + working-directory field; a `chat` session omits the
  diff/approval UI. The composer/interrupt/chat/activity feed are mode-agnostic.
- **contracts:** contract-neutral (no new event types, no envelope/endpoint-signature change). If session
  create's request shape is considered part of the frozen `http-api-contract`, adding an optional `mode` field
  is an additive note in `CHANGELOG.md`, not a breaking change.
- **Consumes (does not modify):** `run-orchestration` (Runs::Start/Finalize), `worktree-management` (skipped in
  chat mode), `session-create` (extends the create form/endpoint), `file-and-diff-api` (diff is simply not
  offered for chat sessions).
- **Out of scope:** running Claude outside the bind-mounted repo root (the sidecar can't `cwd` there);
  converting a session between modes after creation; multi-directory sessions.
