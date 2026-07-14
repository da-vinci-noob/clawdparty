## ADDED Requirements

### Requirement: The review worktree is created from the session's selected repository

A `review`-mode run SHALL create its git worktree from the repository the session points at
(`session.repository_path`), not from the mount root. `Git::WorktreeManager` SHALL use
`session.repository_path` (when present) as the git base for `git worktree add`, falling back to the mount root
(`repo_root`) only when `repository_path` is blank. The worktree working files SHALL live at a centralized path
under the mount root (`repo_root/.clawdparty/worktrees/session-<id>`) so the user's repositories are not
littered with worktree checkouts, and the run's `base_sha`, dirty-check, diff, and reject-reset SHALL operate
on that worktree.

#### Scenario: A review run uses the picked repository

- **WHEN** a review session whose `repository_path` is a git repository under the mount root starts a run
- **THEN** the worktree is created from that repository (its `HEAD`), the run proceeds, and the diff is computed
  against that repository — not the mount root

#### Scenario: Blank repository_path falls back to the mount root

- **WHEN** a review session has no `repository_path` and starts a run
- **THEN** the worktree is created from the mount root (matching prior behavior for single-repo mounts)

#### Scenario: Selecting a non-git folder fails clearly

- **WHEN** a review session points at a folder that is not a git repository and starts a run
- **THEN** the run is refused with a client error explaining the selected folder is not a git repository, and
  no partial/queued run is left blocking the session

### Requirement: The working directory is stored as an absolute, contained path for both modes

Session create and update SHALL resolve `repository_path` to an absolute path contained within the mount root
for BOTH `review` and `chat` modes (defaulting to the mount root when blank), using the one shared
realpath-containment rule. A path that escapes the mount root SHALL be refused with a client error and nothing
persisted. There SHALL NOT be a mode where the working directory is stored unvalidated.

#### Scenario: A review working directory is resolved and contained

- **WHEN** a review session is created or updated with a working directory inside the mount root
- **THEN** the session's `repository_path` is stored as the resolved absolute path under the mount root

#### Scenario: An escaping working directory is refused for review too

- **WHEN** a review session is created or updated with a working directory that resolves outside the mount root
- **THEN** the request is refused with a client error and no session/working-directory change is persisted

### Requirement: Containment resolves relative and absolute-in-root paths identically

The shared containment helper SHALL accept both a path relative to the root and an absolute path already inside
the root, resolving each to the same absolute path without double-prefixing, before applying the realpath
containment check. An absolute path that lies within the root SHALL be accepted unchanged; a relative path
SHALL be resolved against the root.

#### Scenario: A relative path and its absolute form resolve the same

- **WHEN** the helper is given `sub/dir` and separately given the absolute `<root>/sub/dir`
- **THEN** both resolve to the same absolute path under the root and are accepted

#### Scenario: An absolute path outside the root is refused

- **WHEN** the helper is given an absolute path that resolves outside the root
- **THEN** it is refused (the escape rule applies equally to absolute and relative inputs)
