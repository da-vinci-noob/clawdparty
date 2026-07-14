# repo-browser Specification

## Purpose
TBD - created by archiving change file-and-diff-api. Update Purpose after archive.
## Requirements
### Requirement: RepoBrowser is the single safe chokepoint for file content

`RepoBrowser` SHALL be the only path through which file content is served; no controller SHALL read repository
files directly. The file **tree** SHALL be produced from `git ls-files --cached --others --exclude-standard`
(tracked plus untracked-not-ignored, excluding `.git`), so `.gitignore`'d files are never listed. All **content**
reads SHALL pass through the safety pipeline below (containment → denylist → cap → binary detection).

#### Scenario: Tree comes from git ls-files, excluding ignored and .git

- **WHEN** the file tree is requested
- **THEN** it is built from `git ls-files --cached --others --exclude-standard`, listing tracked + untracked
  -not-ignored files and never `.git` internals or `.gitignore`'d files

#### Scenario: All content reads go through RepoBrowser

- **WHEN** any file content is served
- **THEN** it is read via `RepoBrowser`, not directly by a controller

### Requirement: Realpath containment defeats traversal and symlink escape

`RepoBrowser` SHALL resolve a requested path against the worktree root using realpath (following symlinks and
collapsing `..`) and SHALL refuse the read unless the resolved absolute path is contained within the worktree
root. A `../` traversal, an absolute path, or a symlink pointing outside the worktree SHALL be refused — never
served.

#### Scenario: ../ traversal is refused

- **WHEN** a content request uses a `../`-style or absolute path that resolves outside the worktree
- **THEN** `RepoBrowser` refuses it and serves nothing

#### Scenario: Symlink escape is refused

- **WHEN** a requested path is a symlink resolving outside the worktree
- **THEN** containment is checked on the resolved path and the read is refused

### Requirement: Denylist, size cap, and binary detection

After containment, `RepoBrowser` SHALL refuse files matching the secret denylist (`.env*`, `*.pem`, `*.key`,
`id_rsa*`, `*secret*`, anything under `.git/`), SHALL refuse files larger than 1MB, and SHALL detect binary
content by null byte and refuse or mark it rather than serving raw bytes as text. Each refusal SHALL use a
defined status the client can render as "not shown": traversal/denylist/not-found map to `404`; an oversized
file maps to `413`; a binary file maps to `415`.

#### Scenario: Denylisted file is refused

- **WHEN** content is requested for a path matching the denylist (e.g. `.env`, `id_rsa`, a `*secret*` file)
- **THEN** `RepoBrowser` refuses it and does not serve its content

#### Scenario: Oversized file is refused with 413

- **WHEN** a requested file exceeds the 1MB cap
- **THEN** `RepoBrowser` refuses with `413` rather than streaming it

#### Scenario: Binary file is detected and refused with 415

- **WHEN** a requested file contains a null byte (binary)
- **THEN** `RepoBrowser` refuses it with `415` rather than serving raw bytes as text

