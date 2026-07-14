## ADDED Requirements

### Requirement: File tree and content endpoints, view-gated, routed through RepoBrowser

The system SHALL expose `GET /api/sessions/:id/files` (the worktree file tree) and
`GET /api/sessions/:id/files/content?path=…` (a single file's content), under the `/api` scope. Both SHALL be
`SessionPolicy`-gated to the `view` action (all roles may read). The content endpoint SHALL serve only via
`RepoBrowser`, so containment/denylist/cap/binary rules always apply. A refused content read (traversal,
denylist, not found) SHALL respond `404`; an oversized file SHALL respond `413` and a binary file `415` — the
defined refusals the client renders as "not shown".

#### Scenario: Participant reads the tree and an allowed file

- **WHEN** a participant requests the file tree and then an allowed file's content
- **THEN** the tree returns from `git ls-files` and the content returns via `RepoBrowser`, both `200`

#### Scenario: A refused content read returns a defined status

- **WHEN** a content request hits traversal, the denylist, a missing file, or an oversized/binary file
- **THEN** traversal/denylist/not-found return `404`, an oversized file returns `413`, and a binary file
  returns `415` — never the raw content

### Requirement: Cross-session file access is refused with 404

A request for the files of a session the requester is not a participant of SHALL respond `404` (not `403`), so
the response does not confirm the other session's existence (anti-enumeration), consistent with the
`rails-foundation` convention.

#### Scenario: Non-participant file access is 404

- **WHEN** a participant of session A requests session B's file tree or content
- **THEN** the request is refused `404`, not confirming session B exists
