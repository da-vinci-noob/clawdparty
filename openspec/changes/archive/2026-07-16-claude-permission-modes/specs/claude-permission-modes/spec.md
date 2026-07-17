## ADDED Requirements

### Requirement: Users select Claude's permission mode at run start

Run start SHALL accept an optional `permission_mode` and forward it (via `Runs::Start` → the sidecar `POST /runs` payload) after validating it server-side against the allowlist `plan | acceptEdits | bypassPermissions`. When omitted, the mode SHALL default to `acceptEdits` (the prior fixed behavior, so existing clients are unchanged). A value outside the allowlist — including `default`, `dontAsk`, or any ask-per-tool mode — SHALL be rejected with HTTP `422` and a JSON body of the shape `{ errors: [...] }`, and no run SHALL be started. On success, run start behaves exactly as today (asynchronous `202`/queued run), only with the chosen mode.

#### Scenario: Omitted mode defaults to acceptEdits

- **WHEN** a run-capable user starts a run without a `permission_mode`
- **THEN** the run is created and the sidecar payload carries `permission_mode: acceptEdits`

#### Scenario: An allowlisted mode is forwarded

- **WHEN** a run-capable user starts a run with `permission_mode: plan`
- **THEN** the run is created and the sidecar payload carries `permission_mode: plan`

#### Scenario: An unsupported mode is rejected

- **WHEN** a user starts a run with `permission_mode: default` (or any value outside the allowlist)
- **THEN** the request is refused with HTTP `422` and a JSON body of the shape `{ errors: [...] }`, and no run is started

### Requirement: Permission-mode selection is role-gated, with bypass owner-only

Selecting a permission mode SHALL require a run-capable role (`owner` or `editor`, the same gate as starting a run), enforced server-side via `SessionPolicy` independent of the client UI; `reviewer`/`viewer` requests to start a run in any mode SHALL be refused with HTTP `403`. Because `bypassPermissions` is not constrained by the `allowed_tools` whitelist (Claude may invoke tools beyond the whitelist), it SHALL be restricted to `owner`; an `editor` (or lower) requesting `permission_mode: bypassPermissions` SHALL be refused with HTTP `403` and a JSON body of the shape `{ errors: [...] }`, and no run SHALL be started. `plan` and `acceptEdits` SHALL be allowed for both `owner` and `editor`. In all modes `cwd` SHALL remain pinned to the session worktree.

#### Scenario: Editor may start a plan or acceptEdits run

- **WHEN** an `editor` starts a run with `permission_mode: plan` (or `acceptEdits`)
- **THEN** the run is created in that mode

#### Scenario: Only an owner may start a bypass run

- **WHEN** an `editor` starts a run with `permission_mode: bypassPermissions`
- **THEN** the request is refused with HTTP `403` and a JSON body of the shape `{ errors: [...] }`, and no run is started
- **WHEN** an `owner` starts a run with `permission_mode: bypassPermissions`
- **THEN** the run is created in bypass mode

#### Scenario: A viewer/reviewer cannot start a run in any mode

- **WHEN** a `reviewer` or `viewer` attempts to start a run with any `permission_mode`
- **THEN** the request is refused with HTTP `403` and no run is started

### Requirement: Plan runs can be executed by switching mode in-session

After a `plan`-mode run, a run-capable user SHALL be able to continue in `acceptEdits` without re-exploring, by switching the run's permission mode in-session. Rails SHALL expose a role-gated endpoint that forwards to the sidecar `POST /runs/:id/permission_mode`; the target mode SHALL be validated against the same allowlist and role rules (bypass owner-only). If the run is still active, the switch SHALL take effect in-session and subsequent edits SHALL ride the existing changeset-review (approve/reject) flow unchanged. If the run is no longer active (already terminal), the endpoint SHALL respond so the client can fall back to starting a fresh `acceptEdits` run that resumes the same `claude_session_id`.

#### Scenario: Execute a finished/active plan by switching to acceptEdits

- **WHEN** a run-capable user chooses "Execute plan" on a `plan` run that is still active
- **THEN** Rails forwards a permission-mode switch to `acceptEdits` for that run and the run continues in-session, producing edits that go through changeset review

#### Scenario: Switching a non-active run falls back to a fresh run

- **WHEN** "Execute plan" is chosen but the plan run has already reached a terminal state
- **THEN** the switch endpoint reports the run is not active, and the client starts a fresh `acceptEdits` run resuming the same `claude_session_id`

#### Scenario: Mode switch is role-gated

- **WHEN** a `reviewer`/`viewer` calls the permission-mode switch endpoint, or a non-owner requests `bypassPermissions`
- **THEN** the request is refused with HTTP `403` and the run's mode is unchanged

### Requirement: The active permission mode is visible in the UI

The prompt composer SHALL present a mode control (Plan / Auto-accept / Bypass) to run-capable users only, with the Bypass option shown to owners only; the control SHALL send the chosen `permission_mode` on run start. The active run's mode SHALL be surfaced in the run banner, read from the existing `run_started` event payload (which already carries `permission_mode`) — no new event type and no persisted column are introduced. When a `plan` run finishes, the UI SHALL offer an "Execute plan" affordance to run-capable users. Client gating is presentation only; the server enforces the roles and allowlist.

#### Scenario: Non-run roles do not see the mode control

- **WHEN** a `reviewer` or `viewer` views the session
- **THEN** the permission-mode control is not rendered (and the server would refuse a run regardless)

#### Scenario: Bypass is hidden from non-owners

- **WHEN** an `editor` opens the mode control
- **THEN** the Bypass option is not offered (owner-only), while Plan and Auto-accept are

#### Scenario: The run banner shows the active mode

- **WHEN** a run starts in a given mode
- **THEN** the run banner displays that mode, read from the `run_started` event payload
