## ADDED Requirements

### Requirement: Rails creates the session worktree at the frozen path and branch

`Git::WorktreeManager` SHALL create the per-session git worktree at `<repo>/.clawdparty/worktrees/session-<id>`
on branch `clawd/session-<id>`, per the frozen `sidecar-protocol` worktree convention, operating on the target
repository bind-mounted at `/repo`. Rails SHALL own worktree creation; the sidecar SHALL only use the worktree
as its `cwd` and SHALL NOT create or relocate it. The worktree SHALL be created such that its recorded absolute
gitdir resolves inside the sidecar container (which mounts the same repo at the identical `/repo` path).

#### Scenario: Worktree created at the convention path

- **WHEN** a run is started for a session
- **THEN** `Git::WorktreeManager` creates the worktree at `<repo>/.clawdparty/worktrees/session-<id>` on branch
  `clawd/session-<id>`

#### Scenario: A Rails-created worktree resolves when git runs in it as the sidecar user

- **WHEN** the root-owned `rails` service creates the worktree and the non-root `node`-user `sidecar` later runs
  git in it as `cwd`
- **THEN** git does not fail with "dubious ownership" (the `safe.directory` configured by `dev-docker-compose`
  covers `/repo` and the worktrees path), so the worktree is usable from both containers

### Requirement: base_sha is recorded at run start

`Git::WorktreeManager` SHALL record the worktree's `base_sha` (the HEAD commit at the moment the run starts) onto
the `ai_run`, per the frozen `sidecar-protocol`, so later diff/changeset computation has a stable base.

#### Scenario: base_sha captured at start

- **WHEN** a run starts against a freshly-created or reused worktree
- **THEN** the worktree's current HEAD sha is recorded as the run's `base_sha`

### Requirement: Worktree reset and teardown are available

`Git::WorktreeManager` SHALL expose reset (`git reset --hard HEAD && git clean -fd` within the worktree) and
teardown operations, so the reject flow (W3) and cleanup can return a worktree to a clean state. This change
provides the operations; the reject flow that calls reset on approve/reject is W3.

#### Scenario: Reset returns the worktree to a clean tree

- **WHEN** `Git::WorktreeManager` resets a dirty worktree
- **THEN** the worktree is restored to its `base_sha` state with untracked files removed
