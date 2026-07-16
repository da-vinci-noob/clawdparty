## MODIFIED Requirements

### Requirement: Rails-to-sidecar run control endpoints

The contract `docs/contracts/sidecar_protocol.md` SHALL define the Rails→sidecar control surface: `POST /runs`, `POST /runs/:id/messages`, `POST /runs/:id/interrupt`, `POST /runs/:id/permission_mode`, and `GET /healthz`. `POST /runs` SHALL carry at least `run_id`, `session_id`, `repo_path` (the session worktree), `prompt`, `requested_by` (the originating participant id, which the sidecar stamps as `actor.id` on the `run_started` event), optional `claude_session_id`, `model`, `max_turns`, `permission_mode` (an allowlist value — `plan`, `acceptEdits` (the default when omitted), or `bypassPermissions`), and an `allowed_tools` whitelist, and SHALL return `409` when a run is already active. `POST /runs/:id/messages` SHALL carry a body of `{ message, requested_by }` — the follow-up text and the originating participant id — and SHALL push the follow-up into the live streaming-input iterable without respawning the run; `requested_by` is the attribution carried onto any follow-up-driven event's `actor.id`. `POST /runs/:id/interrupt` SHALL carry a body of `{ requested_by }` — the participant id that initiated the interrupt — so the resulting `run_interrupted` event is attributed to that user (interrupt is a human action, unlike the system-attributed `run_finished`/`run_failed`). `POST /runs/:id/permission_mode` SHALL carry a body of `{ permission_mode, requested_by }` and SHALL switch the active run's permission mode in-session (via the SDK query handle) without respawning the run — the mechanism behind the plan→execute flow. `GET /healthz` SHALL report active runs.

The contract SHALL pin the success (2xx) response shape of each endpoint, not only the errors — for a frozen wire seam the success paths are as load-bearing as the failures, and `sample_run.jsonl` only covers the event stream, not these RPC responses. `POST /runs` SHALL return `202 Accepted` with `{ run_id, status: "running" }` (the run proceeds asynchronously; events arrive via the callback). `POST /runs/:id/messages` and `POST /runs/:id/interrupt` SHALL return `200` with `{ run_id, accepted: true }` (and `404`/`409` when the run is unknown or not interruptible). `POST /runs/:id/permission_mode` SHALL return `200` with `{ run_id, permission_mode }` (the applied mode), `404` when the run is unknown, and `409` when the run is no longer active (so it cannot be switched — the caller falls back to a fresh run). `GET /healthz` SHALL return `200` with `{ active_run_ids: [run_id, …] }` — the same key name used by the heartbeat, so the contract names the concept once.

#### Scenario: Starting a run while one is active is rejected

- **WHEN** Rails sends `POST /runs` for a session that already has an active run
- **THEN** the sidecar responds `409` and does not start a second run

#### Scenario: Accepted run start returns the pinned success shape

- **WHEN** Rails sends a valid `POST /runs` and no run is active
- **THEN** the sidecar responds `202` with `{ run_id, status: "running" }` and emits run events via the callback

#### Scenario: run_started carries the requester as its actor

- **WHEN** the sidecar emits the `run_started` event for a run
- **THEN** its `actor` is `{ kind: "user", id: <requested_by> }` using the `requested_by` from the run-start payload, satisfying the event-envelope rule that human-originated events carry the originating participant id

#### Scenario: Follow-up is streamed into the live run

- **WHEN** Rails sends `POST /runs/:id/messages` during an active run
- **THEN** the message is pushed into the run's streaming-input iterable without respawning the run

#### Scenario: Interrupt targets the active run

- **WHEN** Rails sends `POST /runs/:id/interrupt`
- **THEN** the sidecar interrupts that run cleanly

#### Scenario: Permission mode is switched on the active run

- **WHEN** Rails sends `POST /runs/:id/permission_mode` with `{ permission_mode, requested_by }` during an active run
- **THEN** the sidecar switches that run's permission mode in-session via the SDK query handle (no respawn) and responds `200` with `{ run_id, permission_mode }`, or `409` if the run is no longer active

### Requirement: Permission mode and tool scoping at run start

The contract SHALL specify that a run's `permission_mode` is a selectable allowlist value — `plan`, `acceptEdits` (the default when the field is omitted), or `bypassPermissions` — and that every run carries an `allowed_tools` whitelist and `cwd` pinned to the session worktree in all modes. `acceptEdits` auto-approves file edits within the whitelist (the prior fixed behavior); `plan` explores with read-only tools and does not make file edits; `bypassPermissions` auto-approves all tools and, per the SDK, is NOT constrained by `allowed_tools`, so Rails SHALL restrict it to owners (enforced server-side by `SessionPolicy`, not by the sidecar). Values outside the allowlist (including `default`/`dontAsk`/ask-per-tool) SHALL be rejected by Rails before reaching the sidecar. The `canUseTool` permission hook SHALL remain allow-all for the MVP and is documented as the seam for later per-tool Bash gating; live per-tool approval remains out of scope.

#### Scenario: Run start defaults to acceptEdits and pins cwd

- **WHEN** Rails starts a run without a `permission_mode`
- **THEN** the run carries `permission_mode: acceptEdits`, an `allowed_tools` whitelist, and `cwd` set to the session worktree

#### Scenario: A selected allowlist mode is honored

- **WHEN** Rails starts a run with `permission_mode: plan` (or `bypassPermissions`)
- **THEN** the sidecar starts the run in that mode with `cwd` still pinned to the session worktree

#### Scenario: A plan-mode run makes no file edits

- **WHEN** a run is started in `plan` mode
- **THEN** Claude explores with read-only tools and produces a plan without editing files, so no changeset is produced by that run
