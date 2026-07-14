# directory-picker Specification

## Purpose
TBD - created by archiving change directory-picker. Update Purpose after archive.
## Requirements
### Requirement: List directories under the repo root, containment-checked and git-flagged

`GET /api/directories?path=<relative>` SHALL return the immediate subdirectories of the given path resolved
against the mounted repo root, each with its name, its path relative to the root, and an `is_git_repo` flag.
The resolved path SHALL be realpath-contained within the repo root (defeating `../` and symlink escape); a path
resolving outside the root SHALL be refused with a client error and no listing returned. An absent/blank `path`
SHALL list the repo root itself. The request SHALL require a valid participant cookie (like every `/api` read).

#### Scenario: Lists immediate subdirectories with git markers

- **WHEN** a participant requests `GET /api/directories` (no path) and the repo root contains folders, some git
  repos and some not
- **THEN** the response lists each immediate subdirectory with its relative path and `is_git_repo` true/false,
  and does not recurse into them

#### Scenario: A traversal / escaping path is refused

- **WHEN** the requested `path` resolves outside the repo root (via `../`, an absolute path, or a symlink)
- **THEN** the request is refused with a client error and no directory listing is returned

#### Scenario: Unauthenticated request is refused

- **WHEN** the request carries no valid participant cookie
- **THEN** it is refused (not served a listing)

### Requirement: Change a session's working directory (owner-gated, next run applies)

`PATCH /api/sessions/:id` SHALL let an **owner** change the session's working directory (`repository_path`),
realpath-contained within the repo root; the new directory SHALL apply to the session's **subsequent** runs and
SHALL NOT alter an in-flight run. A non-owner participant SHALL be refused `403`; a non-participant or unknown
session SHALL be refused `404` (anti-enumeration); an escaping directory SHALL be refused with a client error.

#### Scenario: Owner changes the working directory

- **WHEN** an owner PATCHes the session with a new (contained) directory
- **THEN** the session's `repository_path` is updated and the next run uses it as its `cwd`

#### Scenario: Non-owner is refused

- **WHEN** an editor/reviewer/viewer attempts to change the directory
- **THEN** the request is refused `403` and the directory is unchanged

#### Scenario: Escaping directory is refused

- **WHEN** the requested directory resolves outside the repo root
- **THEN** the request is refused with a client error and the directory is unchanged

### Requirement: Containment is enforced by one shared implementation

The realpath-containment check SHALL be implemented once and reused by the directory listing, session create,
and session update: resolve the requested path against the repo root and refuse it unless the resolved path
stays inside. There SHALL NOT be divergent copies of this rule that could disagree.

#### Scenario: All three paths refuse the same escape

- **WHEN** an escaping path is supplied to the listing endpoint, to session create, or to session update
- **THEN** each refuses it identically (the same containment rule), never serving/persisting the escaping path

### Requirement: The web offers a folder picker for both modes and to change directory

The create form SHALL let the user pick the working directory via a folder browser (navigate into/out of
subdirectories under the repo root, select one) for BOTH `review` and `chat` modes, showing the git-repo
marker. The session page SHALL offer an owner-only control to change the working directory via the same picker
(`PATCH`). If the directory-listing endpoint errors, the UI SHALL fall back to a plain text directory input so
a listing outage never blocks creating a session.

#### Scenario: Pick a folder when creating a session

- **WHEN** the user opens the create form and navigates the folder picker
- **THEN** they can descend into subdirectories, go back up, and select a folder as the working directory,
  seeing which folders are git repos

#### Scenario: Owner changes a session's directory from the session page

- **WHEN** an owner uses the change-directory control and picks a folder
- **THEN** the session's working directory is updated via `PATCH` (applied to the next run)

#### Scenario: Listing outage falls back to a text field

- **WHEN** `GET /api/directories` errors
- **THEN** the create form still lets the user type a directory path (no hard block on creating a session)

