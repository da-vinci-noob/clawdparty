## ADDED Requirements

### Requirement: A session has a run mode chosen at creation

A session SHALL have a `mode` of either `review` (the default, git-backed) or `chat`, fixed for the session's
lifetime and chosen at create time. `review` mode SHALL behave exactly as today (per-session worktree,
`base_sha`, diff, approve/reject). Existing sessions and any create request that omits `mode` SHALL be
`review`.

#### Scenario: Default mode is review

- **WHEN** a session is created without a `mode`
- **THEN** its mode is `review` and it behaves exactly as the current git-backed flow (worktree, diff,
  approve/reject)

#### Scenario: Create a chat-mode session

- **WHEN** a session is created with `mode: "chat"` and a working directory
- **THEN** the session is persisted with mode `chat` and that working directory

### Requirement: The chat working directory is contained within the mounted repo root

A `chat` session's working directory SHALL be realpath-resolved and confirmed to be within the bind-mounted
repo root before use (defeating `../` and symlink escape, the same containment rule the file API uses). A
directory that resolves outside the repo root SHALL be refused at create with a client error; it SHALL NOT be
persisted or handed to the sidecar. When no working directory is given, the mounted repo root SHALL be used.

#### Scenario: An escaping working directory is refused

- **WHEN** a chat session is created with a working directory that resolves outside the mounted repo root
  (via `../` or a symlink)
- **THEN** the request is refused with a client error and no session is created

#### Scenario: Omitted working directory defaults to the repo root

- **WHEN** a chat session is created with no working directory
- **THEN** the mounted repo root is used as the working directory

### Requirement: A chat run starts without a worktree or base_sha and runs in the working directory

For a `chat`-mode session, `Runs::Start` SHALL NOT create a git worktree, SHALL NOT require a clean/dirty check,
and SHALL NOT record `base_sha`; it SHALL pin the sidecar `cwd` to the session's working directory and otherwise
start the run through the existing path (one active run per session still enforced; the sidecar protocol
unchanged). For a `review`-mode session, `Runs::Start` SHALL be unchanged (worktree + `base_sha`).

#### Scenario: Chat run skips the worktree

- **WHEN** a run is started on a `chat` session
- **THEN** no git worktree is created, `base_sha` is not recorded, and the sidecar is invoked with `cwd` set to
  the session's working directory

#### Scenario: Chat run works when the directory is not a git repository

- **WHEN** the chat working directory is not a git repository
- **THEN** the run still starts (no `GitError`), because chat mode never invokes git

#### Scenario: One active run per session still holds

- **WHEN** a chat run is already active for a session and another start is requested
- **THEN** it is refused with the one-active-run conflict, exactly as in review mode

### Requirement: A chat run finalizes without a review gate

`Runs::Finalize` SHALL map a `chat` run's `run_finished` to `completed_clean` and its `run_interrupted` to
`completed_clean` (there is no changeset to review); `run_failed` SHALL map to `failed` as in review mode. A
chat run SHALL NOT enter `awaiting_review`. No new run status is introduced.

#### Scenario: Chat run completes without awaiting review

- **WHEN** a `chat` run emits `run_finished`
- **THEN** the run's status becomes `completed_clean` and it never enters `awaiting_review`

#### Scenario: Interrupted chat run completes cleanly

- **WHEN** a `chat` run emits `run_interrupted`
- **THEN** the run's status becomes `completed_clean` (nothing to review)

### Requirement: Both modes share the same live event stream; chat omits the review UI

A `chat` run SHALL produce the identical Contract-1 event stream as a `review` run (`run_started`,
`user_prompt`, `ai_text`/`ai_text_delta`, `ai_thinking`, `tool_*`, `terminal_output`, `file_changed`,
`run_finished`/`run_failed`/`run_interrupted`) — no new event types. The web SHALL render the activity feed,
prompt composer, interrupt, and chat identically for both modes, and SHALL omit the diff/approval affordances
for a `chat` session.

#### Scenario: Chat activity is watchable like review

- **WHEN** a `chat` run is live
- **THEN** the activity feed, prompt composer, interrupt, and chat behave exactly as in a review session
  (same events, no new types)

#### Scenario: Chat session hides approval UI

- **WHEN** a participant views a `chat` session
- **THEN** the diff/approve/reject affordances are not shown (there is no changeset), while read-only viewing
  remains available
