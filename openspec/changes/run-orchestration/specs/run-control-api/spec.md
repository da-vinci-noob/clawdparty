## ADDED Requirements

### Requirement: Role-gated run-control endpoints forward to the sidecar

The system SHALL expose `POST /api/sessions/:id/runs` (start), `POST /api/runs/:id/messages` (follow-up), and
`POST /api/runs/:id/interrupt` (interrupt), under the `/api` path scope. Each SHALL be gated by `SessionPolicy`:
start, follow-up, and interrupt are permitted to **owner** and **editor** only (per the frozen
`http-api-contract` role matrix). A participant whose role is not permitted SHALL be denied `403` with a
`{ errors: [...] }` body; a non-participant or unknown session SHALL be `404` (anti-enumeration). Each endpoint
SHALL forward to the sidecar via `Sidecar::Client`.

#### Scenario: Reviewer/viewer cannot start, follow-up, or interrupt

- **WHEN** a participant whose role is `reviewer` or `viewer` calls any run-control endpoint
- **THEN** the server responds `403` with `{ errors: [...] }`, regardless of the client UI

#### Scenario: Owner/editor may start, follow-up, and interrupt

- **WHEN** an `owner` or `editor` participant calls a run-control endpoint
- **THEN** the action is permitted and forwarded to the sidecar via `Sidecar::Client`

#### Scenario: Non-participant gets 404, not 403

- **WHEN** a non-participant (or unknown session) calls a run-control endpoint
- **THEN** the server responds `404`, not confirming the session's existence

### Requirement: Sidecar::Client is the only Rails→sidecar caller and is configurable

`Sidecar::Client` SHALL be the sole Rails→sidecar caller for `POST /runs`, `POST /runs/:id/messages`, and
`POST /runs/:id/interrupt`, targeting `SIDECAR_URL` (default `http://sidecar:8787`) with no hard-coded host. It
SHALL map the frozen `sidecar-protocol` responses: `202` on accepted start, `200` on accepted follow-up/interrupt,
`409` when a run is already active (surfaced to the client as `409`), and `404` for an unknown run.

#### Scenario: Client targets the configurable sidecar URL

- **WHEN** Rails calls the sidecar
- **THEN** `Sidecar::Client` uses `SIDECAR_URL` (default `http://sidecar:8787`), not a hard-coded address

#### Scenario: Active-run conflict surfaces as 409

- **WHEN** a start is attempted while the sidecar reports a run already active (`409`)
- **THEN** the run-control endpoint surfaces `409` to the client and does not create a second active run

### Requirement: Run status is derived from events, never a bespoke cable message

The run-control surface SHALL NOT introduce any bespoke cable message for run status. A run's status SHALL be
derivable from its lifecycle events (`run_started`/`run_finished`/`run_failed`/`run_interrupted`/`changeset_ready`)
already broadcast as Contract-1 envelopes, consistent with the frozen rule that everything live arrives as an
event.

#### Scenario: No custom run-status message is broadcast

- **WHEN** a run advances through its lifecycle
- **THEN** clients learn the status from the run-lifecycle Contract-1 events, and no custom run-status cable
  message shape is introduced

### Requirement: Run-start is asynchronous to the client

`POST /api/sessions/:id/runs` SHALL create the run, append `run_started`, call the sidecar (which returns `202`),
and respond to the client without waiting for the run to finish. The run advances to `running` and to its
terminal state via `Runs::Finalize` reacting to ingested events.

#### Scenario: Start responds before completion

- **WHEN** a permitted participant starts a run
- **THEN** the endpoint responds promptly after the sidecar accepts (`202`), and the run's later progress arrives
  as events rather than blocking the start response
