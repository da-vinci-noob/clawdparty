# harness-protocol Specification

## Purpose
TBD - created by archiving change freeze-interface-contracts. Update Purpose after archive.
## Requirements
### Requirement: Rails-to-harness run control endpoints

The contract `docs/contracts/harness_protocol.md` SHALL define the Rails→harness control surface: `POST /runs`, `POST /runs/:id/messages`, `POST /runs/:id/interrupt`, `POST /runs/:id/permission_mode`, and `GET /healthz`. `POST /runs` SHALL carry at least `run_id`, `session_id`, `repo_path` (the session worktree), `prompt`, `requested_by` (the originating participant id, which the harness stamps as `actor.id` on the `run_started` event), optional `claude_session_id`, `model`, `max_turns`, `permission_mode` (an allowlist value — `plan`, `acceptEdits` (the default when omitted), or `bypassPermissions`), and an `allowed_tools` whitelist, and SHALL return `409` when a run is already active. `POST /runs/:id/messages` SHALL carry a body of `{ message, requested_by }` — the follow-up text and the originating participant id — and SHALL push the follow-up into the live streaming-input iterable without respawning the run; `requested_by` is the attribution carried onto any follow-up-driven event's `actor.id`. `POST /runs/:id/interrupt` SHALL carry a body of `{ requested_by }` — the participant id that initiated the interrupt — so the resulting `run_interrupted` event is attributed to that user (interrupt is a human action, unlike the system-attributed `run_finished`/`run_failed`). `POST /runs/:id/permission_mode` SHALL carry a body of `{ permission_mode, requested_by }` and SHALL switch the active run's permission mode in-session (via the SDK query handle) without respawning the run — the mechanism behind the plan→execute flow. `GET /healthz` SHALL report active runs.

The contract SHALL pin the success (2xx) response shape of each endpoint, not only the errors — for a frozen wire seam the success paths are as load-bearing as the failures, and `sample_run.jsonl` only covers the event stream, not these RPC responses. `POST /runs` SHALL return `202 Accepted` with `{ run_id, status: "running" }` (the run proceeds asynchronously; events arrive via the callback). `POST /runs/:id/messages` and `POST /runs/:id/interrupt` SHALL return `200` with `{ run_id, accepted: true }` (and `404`/`409` when the run is unknown or not interruptible). `POST /runs/:id/permission_mode` SHALL return `200` with `{ run_id, permission_mode }` (the applied mode), `404` when the run is unknown, and `409` when the run is no longer active (so it cannot be switched — the caller falls back to a fresh run). `GET /healthz` SHALL return `200` with `{ active_run_ids: [run_id, …] }` — the same key name used by the heartbeat, so the contract names the concept once.

#### Scenario: Starting a run while one is active is rejected

- **WHEN** Rails sends `POST /runs` for a session that already has an active run
- **THEN** the harness responds `409` and does not start a second run

#### Scenario: Accepted run start returns the pinned success shape

- **WHEN** Rails sends a valid `POST /runs` and no run is active
- **THEN** the harness responds `202` with `{ run_id, status: "running" }` and emits run events via the callback

#### Scenario: run_started carries the requester as its actor

- **WHEN** the harness emits the `run_started` event for a run
- **THEN** its `actor` is `{ kind: "user", id: <requested_by> }` using the `requested_by` from the run-start payload, satisfying the event-envelope rule that human-originated events carry the originating participant id

#### Scenario: Follow-up is streamed into the live run

- **WHEN** Rails sends `POST /runs/:id/messages` during an active run
- **THEN** the message is pushed into the run's streaming-input iterable without respawning the run

#### Scenario: Interrupt targets the active run

- **WHEN** Rails sends `POST /runs/:id/interrupt`
- **THEN** the harness interrupts that run cleanly

#### Scenario: Permission mode is switched on the active run

- **WHEN** Rails sends `POST /runs/:id/permission_mode` with `{ permission_mode, requested_by }` during an active run
- **THEN** the harness switches that run's permission mode in-session via the SDK query handle (no respawn) and responds `200` with `{ run_id, permission_mode }`, or `409` if the run is no longer active

### Requirement: Harness-to-Rails callback endpoints

The contract SHALL define the harness→Rails callbacks: `POST /internal/events` (batched, idempotent event ingest) and `POST /internal/harness/heartbeat` (sent every 5 seconds with the set of active run ids). Both SHALL be authenticated with a bearer `HARNESS_SHARED_SECRET`. The `POST /internal/events` **request body** SHALL be a JSON object `{ events: Event[] }` (a named array, not a bare top-level array — so the envelope can carry future sibling fields additively); each element is a Contract-1 event envelope. The heartbeat **request body** SHALL be `{ active_run_ids: [...] }`. Event batches SHALL be idempotent per the `(ai_run_id, seq)` rule defined in the event-envelope capability. `POST /internal/events` SHALL respond `200` with a body reporting accepted and skipped counts (`{ accepted, skipped }`, where `skipped` counts duplicates deduped on `(ai_run_id, seq)`); a malformed batch (unparseable body, missing `events`, or an element missing required envelope fields) SHALL be rejected with `422` and ingest nothing; `409` is reserved for run-start conflicts and is NOT used by this batch endpoint. Ingest SHALL be **best-effort per event** within a parseable batch: each valid event is upserted independently (duplicates skipped), so one already-persisted event does not reject the batch — the `{ accepted, skipped }` counts report the outcome. `POST /internal/harness/heartbeat` SHALL respond `200` with `{ ok: true }` on success. A missing or invalid bearer token on either callback SHALL be rejected with `401` and SHALL ingest nothing; the bearer comparison on both callbacks SHALL use a constant-time comparison to resist timing attacks (so every bearer-verifying endpoint inherits the rule from one place). The only statuses these callbacks are contract-defined to return are `200`, `422` (`/internal/events` malformed batch), and `401`; `403`/`404` are NOT contract-defined here (the bearer-authed internal callbacks do not run `SessionPolicy`), so a `403`/`404` can only mean a misconfiguration/misroute and a client MAY treat it defensively as fatal.

#### Scenario: Event ingest is bearer-authenticated and batched

- **WHEN** the harness POSTs a batch to `/internal/events`
- **THEN** the request carries the `HARNESS_SHARED_SECRET` bearer token and the batch is accepted idempotently

#### Scenario: Heartbeat reports active runs every 5 seconds

- **WHEN** the harness is running
- **THEN** it POSTs `/internal/harness/heartbeat` every 5 seconds with the current `active_run_ids`

#### Scenario: Heartbeat success returns the pinned shape

- **WHEN** the harness POSTs `/internal/harness/heartbeat` with a valid bearer token
- **THEN** Rails responds `200` with `{ ok: true }`, and a missing or invalid bearer is rejected `401`

### Requirement: Worktree convention and base_sha rule

The contract SHALL fix the worktree convention as the A↔B seam: **Rails** creates the worktree at `<repo>/.clawdparty/worktrees/session-<id>` on branch `clawd/session-<id>`; the harness receives the worktree path as the run's `cwd` and SHALL NOT create or relocate it. The contract SHALL specify that `base_sha` is recorded at run start. The worktree path SHALL be consistent between the Rails and harness containers (both bind-mount the target repo at the same path) because git worktrees record absolute `.git` paths.

#### Scenario: Rails owns worktree creation

- **WHEN** a session run is started
- **THEN** the worktree at `<repo>/.clawdparty/worktrees/session-<id>` (branch `clawd/session-<id>`) is created by Rails, and the harness only uses it as `cwd`

#### Scenario: base_sha is captured at run start

- **WHEN** a run starts
- **THEN** the `base_sha` of the worktree at that moment is recorded for later diff/changeset computation

### Requirement: Compose-network addressing

The contract SHALL specify that Rails reaches the harness at a configurable URL (`HARNESS_URL`, default `http://harness:8787` over the Docker compose network) and that the harness reaches Rails at a configurable callback base URL. No component SHALL hard-code a fixed host or assume loopback, so that remote/Tailscale operation remains a future drop-in.

#### Scenario: Harness URL is configurable

- **WHEN** Rails needs to call the harness
- **THEN** it uses `HARNESS_URL` (default `http://harness:8787`) rather than a hard-coded address

### Requirement: Permission mode and tool scoping at run start

The contract SHALL specify that a run's `permission_mode` is a selectable allowlist value — `plan`, `acceptEdits` (the default when the field is omitted), or `bypassPermissions` — and that every run carries an `allowed_tools` whitelist and `cwd` pinned to the session worktree in all modes. `acceptEdits` auto-approves file edits within the whitelist (the prior fixed behavior); `plan` explores with read-only tools and does not make file edits; `bypassPermissions` auto-approves all tools and, per the SDK, is NOT constrained by `allowed_tools`, so Rails SHALL restrict it to owners (enforced server-side by `SessionPolicy`, not by the harness). Values outside the allowlist (including `default`/`dontAsk`/ask-per-tool) SHALL be rejected by Rails before reaching the harness. The `canUseTool` permission hook SHALL remain allow-all for the MVP and is documented as the seam for later per-tool Bash gating; live per-tool approval remains out of scope.

#### Scenario: Run start defaults to acceptEdits and pins cwd

- **WHEN** Rails starts a run without a `permission_mode`
- **THEN** the run carries `permission_mode: acceptEdits`, an `allowed_tools` whitelist, and `cwd` set to the session worktree

#### Scenario: A selected allowlist mode is honored

- **WHEN** Rails starts a run with `permission_mode: plan` (or `bypassPermissions`)
- **THEN** the harness starts the run in that mode with `cwd` still pinned to the session worktree

#### Scenario: A plan-mode run makes no file edits

- **WHEN** a run is started in `plan` mode
- **THEN** Claude explores with read-only tools and produces a plan without editing files, so no changeset is produced by that run

