## ADDED Requirements

### Requirement: Rails-to-sidecar run control endpoints

The contract `docs/contracts/sidecar_protocol.md` SHALL define the Rails→sidecar control surface: `POST /runs`, `POST /runs/:id/messages`, `POST /runs/:id/interrupt`, and `GET /healthz`. `POST /runs` SHALL carry at least `run_id`, `session_id`, `repo_path` (the session worktree), `prompt`, `requested_by` (the originating participant id, which the sidecar stamps as `actor.id` on the `run_started` event), optional `claude_session_id`, `model`, `max_turns`, `permission_mode` (`acceptEdits`), and an `allowed_tools` whitelist, and SHALL return `409` when a run is already active. `POST /runs/:id/messages` SHALL carry a body of `{ message, requested_by }` — the follow-up text and the originating participant id — and SHALL push the follow-up into the live streaming-input iterable without respawning the run; `requested_by` is the attribution carried onto any follow-up-driven event's `actor.id`. `POST /runs/:id/interrupt` SHALL carry a body of `{ requested_by }` — the participant id that initiated the interrupt — so the resulting `run_interrupted` event is attributed to that user (interrupt is a human action, unlike the system-attributed `run_finished`/`run_failed`). `GET /healthz` SHALL report active runs.

The contract SHALL pin the success (2xx) response shape of each endpoint, not only the errors — for a frozen wire seam the success paths are as load-bearing as the failures, and `sample_run.jsonl` only covers the event stream, not these RPC responses. `POST /runs` SHALL return `202 Accepted` with `{ run_id, status: "running" }` (the run proceeds asynchronously; events arrive via the callback). `POST /runs/:id/messages` and `POST /runs/:id/interrupt` SHALL return `200` with `{ run_id, accepted: true }` (and `404`/`409` when the run is unknown or not interruptible). `GET /healthz` SHALL return `200` with `{ active_run_ids: [run_id, …] }` — the same key name used by the heartbeat, so the contract names the concept once.

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

### Requirement: Sidecar-to-Rails callback endpoints

The contract SHALL define the sidecar→Rails callbacks: `POST /internal/events` (batched, idempotent event ingest) and `POST /internal/sidecar/heartbeat` (sent every 5 seconds with the set of active run ids). Both SHALL be authenticated with a bearer `SIDECAR_SHARED_SECRET`. The `POST /internal/events` **request body** SHALL be a JSON object `{ events: Event[] }` (a named array, not a bare top-level array — so the envelope can carry future sibling fields additively); each element is a Contract-1 event envelope. The heartbeat **request body** SHALL be `{ active_run_ids: [...] }`. Event batches SHALL be idempotent per the `(ai_run_id, seq)` rule defined in the event-envelope capability. `POST /internal/events` SHALL respond `200` with a body reporting accepted and skipped counts (`{ accepted, skipped }`, where `skipped` counts duplicates deduped on `(ai_run_id, seq)`); a malformed batch (unparseable body, missing `events`, or an element missing required envelope fields) SHALL be rejected with `422` and ingest nothing; `409` is reserved for run-start conflicts and is NOT used by this batch endpoint. Ingest SHALL be **best-effort per event** within a parseable batch: each valid event is upserted independently (duplicates skipped), so one already-persisted event does not reject the batch — the `{ accepted, skipped }` counts report the outcome. `POST /internal/sidecar/heartbeat` SHALL respond `200` with `{ ok: true }` on success. A missing or invalid bearer token on either callback SHALL be rejected with `401` and SHALL ingest nothing; the bearer comparison on both callbacks SHALL use a constant-time comparison to resist timing attacks (so every bearer-verifying endpoint inherits the rule from one place). The only statuses these callbacks are contract-defined to return are `200`, `422` (`/internal/events` malformed batch), and `401`; `403`/`404` are NOT contract-defined here (the bearer-authed internal callbacks do not run `SessionPolicy`), so a `403`/`404` can only mean a misconfiguration/misroute and a client MAY treat it defensively as fatal.

#### Scenario: Event ingest is bearer-authenticated and batched

- **WHEN** the sidecar POSTs a batch to `/internal/events`
- **THEN** the request carries the `SIDECAR_SHARED_SECRET` bearer token and the batch is accepted idempotently

#### Scenario: Heartbeat reports active runs every 5 seconds

- **WHEN** the sidecar is running
- **THEN** it POSTs `/internal/sidecar/heartbeat` every 5 seconds with the current `active_run_ids`

#### Scenario: Heartbeat success returns the pinned shape

- **WHEN** the sidecar POSTs `/internal/sidecar/heartbeat` with a valid bearer token
- **THEN** Rails responds `200` with `{ ok: true }`, and a missing or invalid bearer is rejected `401`

### Requirement: Worktree convention and base_sha rule

The contract SHALL fix the worktree convention as the A↔B seam: **Rails** creates the worktree at `<repo>/.clawdparty/worktrees/session-<id>` on branch `clawd/session-<id>`; the sidecar receives the worktree path as the run's `cwd` and SHALL NOT create or relocate it. The contract SHALL specify that `base_sha` is recorded at run start. The worktree path SHALL be consistent between the Rails and sidecar containers (both bind-mount the target repo at the same path) because git worktrees record absolute `.git` paths.

#### Scenario: Rails owns worktree creation

- **WHEN** a session run is started
- **THEN** the worktree at `<repo>/.clawdparty/worktrees/session-<id>` (branch `clawd/session-<id>`) is created by Rails, and the sidecar only uses it as `cwd`

#### Scenario: base_sha is captured at run start

- **WHEN** a run starts
- **THEN** the `base_sha` of the worktree at that moment is recorded for later diff/changeset computation

### Requirement: Compose-network addressing

The contract SHALL specify that Rails reaches the sidecar at a configurable URL (`SIDECAR_URL`, default `http://sidecar:8787` over the Docker compose network) and that the sidecar reaches Rails at a configurable callback base URL. No component SHALL hard-code a fixed host or assume loopback, so that remote/Tailscale operation remains a future drop-in.

#### Scenario: Sidecar URL is configurable

- **WHEN** Rails needs to call the sidecar
- **THEN** it uses `SIDECAR_URL` (default `http://sidecar:8787`) rather than a hard-coded address

### Requirement: Permission mode and tool scoping at run start

The contract SHALL specify that every run starts with `permission_mode: acceptEdits`, an `allowed_tools` whitelist, and `cwd` pinned to the session worktree. The `canUseTool` permission hook SHALL be allow-all for the MVP and is documented as the seam for later per-tool Bash gating.

#### Scenario: Run start pins cwd and tool scope

- **WHEN** Rails starts a run
- **THEN** the run carries `permission_mode: acceptEdits`, an `allowed_tools` whitelist, and `cwd` set to the session worktree
