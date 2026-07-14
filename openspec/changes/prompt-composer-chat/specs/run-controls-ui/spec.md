## ADDED Requirements

### Requirement: Prompt composer starts runs and sends follow-ups, role-gated client-side

The prompt composer SHALL start a run via `POST /api/sessions/:id/runs` and send a follow-up via
`POST /api/runs/:id/messages`. It SHALL render only for participants whose role is owner or editor; for reviewer
and viewer it SHALL be hidden. This client gating is presentation only — the server `SessionPolicy` remains the
authoritative gate (a hidden control invoked anyway is denied `403` server-side).

#### Scenario: Owner/editor see the composer; reviewer/viewer do not

- **WHEN** the session UI renders for a participant
- **THEN** the prompt composer is shown for owner/editor and hidden for reviewer/viewer

#### Scenario: Composer starts a run and sends follow-ups

- **WHEN** an owner/editor submits a prompt (no active run) or a follow-up (active run)
- **THEN** the client POSTs `/api/sessions/:id/runs` or `/api/runs/:id/messages` respectively

#### Scenario: Client gating is not the security boundary

- **WHEN** a reviewer/viewer somehow triggers a run-control request
- **THEN** the server denies it `403` (the client hiding is presentation only)

### Requirement: Interrupt button shows for owner/editor while a run is active

The interrupt button SHALL POST `POST /api/runs/:id/interrupt` and SHALL render only for owner/editor and only
while a run is active. "Active" SHALL be derived from run-lifecycle events in the store (a `run_started` with no
terminal lifecycle event for that `ai_run_id`), not from any bespoke run-status message.

#### Scenario: Interrupt is visible only during an active run for owner/editor

- **WHEN** a run is active and the viewer is owner/editor
- **THEN** the interrupt button is shown; it is hidden when no run is active or for reviewer/viewer

#### Scenario: Active state derives from lifecycle events

- **WHEN** determining whether to show interrupt
- **THEN** the client uses the store's run-lifecycle events (start without terminal), not a custom run-status
  message
