## ADDED Requirements

### Requirement: An owner can archive a session as a hard close

The system SHALL expose `POST /api/sessions/:id/archive`, gated by an owner-only `archive`
permission per the frozen `http-api-contract` role matrix. On success it SHALL transition the
session `status` from `active` to `archived` and respond `200` with a JSON body
`{ id: <string>, status: "archived" }`. The action SHALL be idempotent: archiving an
already-archived session SHALL also respond `200` with `status: "archived"` and make no further
change. There SHALL be no un-archive path — `archived` is terminal.

A request from a participant whose role is not owner SHALL be refused with HTTP `403` and a JSON
body of the shape `{ errors: [...] }`. A request for a session the caller is not a participant of,
or that does not exist, SHALL be refused with HTTP `404` and a JSON body of the shape
`{ errors: [...] }`, the two cases indistinguishable (anti-enumeration, per `http-api-contract`).

#### Scenario: Owner archives an active session

- **WHEN** an owner sends `POST /api/sessions/:id/archive` for an `active` session
- **THEN** the response is `200` with body `{ id, status: "archived" }` and the session's stored
  `status` becomes `archived`

#### Scenario: Archiving is idempotent

- **WHEN** an owner archives a session that is already `archived`
- **THEN** the response is `200` with `status: "archived"` and no error, and nothing else changes

#### Scenario: Non-owner participant is denied

- **WHEN** an `editor`, `reviewer`, or `viewer` participant sends `POST /api/sessions/:id/archive`
- **THEN** the request is refused with HTTP `403` and a JSON body of the shape `{ errors: [...] }`,
  and the session status is unchanged

#### Scenario: Non-participant or unknown session is refused with 404

- **WHEN** a caller who is not a participant of the session (or names a session that does not
  exist) sends the archive request
- **THEN** the request is refused with HTTP `404` and a JSON body of the shape `{ errors: [...] }`,
  the two cases indistinguishable

### Requirement: Starting a run on an archived session is refused

`Runs::Start` SHALL refuse to start a run when the target session's `status` is `archived`,
raising a distinct error that `RunsController` maps to HTTP `409` with a JSON body of the shape
`{ errors: [...] }`. The guard SHALL live in the `Runs::Start` service so the invariant holds for
every caller, consistent with the existing `ActiveRunExists` / `DirtyWorktree` guards. An
in-flight run started before archival is NOT interrupted by archival; archive blocks only new runs.

#### Scenario: A fresh run is refused on an archived session

- **WHEN** any permitted role attempts `POST /api/sessions/:id/runs` on a session whose `status` is
  `archived`
- **THEN** the server responds `409` with a JSON body of the shape `{ errors: [...] }` and no run
  is created

#### Scenario: An active session still starts runs

- **WHEN** a permitted role starts a run on an `active` session
- **THEN** the run starts normally (the archive guard does not affect active sessions)
