# harness-protocol Specification

## Purpose
TBD - created by archiving change freeze-interface-contracts. Update Purpose after archive.
## Requirements
### Requirement: Rails-to-harness run control endpoints

The contract `docs/contracts/harness_protocol.md` SHALL define the Rails→harness control surface: `POST /runs`, `POST /runs/:id/messages`, `POST /runs/:id/interrupt`, `GET /runs`, and `GET /healthz`. `POST /runs` SHALL carry at least `run_id`, `session_id`, `repo_path` (the session worktree), `prompt`, `requested_by` (the originating participant id, which the harness stamps as `actor.id` on the `run_started` event), `lane`, `provider`, `resume_context` (a boolean, replacing the run-carried session id), `model`, and the optional per-run scoping fields, and SHALL return `409` when that LANE already has an active run. `POST /runs/:id/messages` SHALL carry a body of `{ message, requested_by }` — the follow-up text and the originating participant id — and SHALL push the follow-up into the live streaming-input iterable without respawning the run; `requested_by` is the attribution carried onto any follow-up-driven event's `actor.id`. `POST /runs/:id/interrupt` SHALL carry a body of `{ requested_by }` — the participant id that initiated the interrupt — so the resulting `run_interrupted` event is attributed to that user (interrupt is a human action, unlike the system-attributed `run_finished`/`run_failed`). `GET /healthz` SHALL report active runs.

The contract SHALL pin the success (2xx) response shape of each endpoint, not only the errors — for a frozen wire seam the success paths are as load-bearing as the failures, and `sample_run.jsonl` only covers the event stream, not these RPC responses. `POST /runs` SHALL return `202 Accepted` with `{ run_id, status: "running" }` (the run proceeds asynchronously; events arrive via the callback). `POST /runs/:id/messages` and `POST /runs/:id/interrupt` SHALL return `200` with `{ run_id, accepted: true }` (and `404`/`409` when the run is unknown or not interruptible). `GET /healthz` SHALL return `200` with `{ active_run_ids: [run_id, …] }` — the same key name used by the heartbeat, so the contract names the concept once.

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

### Requirement: Tool scoping at run start

`POST /runs` SHALL carry no mode field of any kind, and SHALL pin `cwd` to the session worktree in
all modes. What a run may do SHALL be expressed as its per-run TOOL SET, and the only thing that may
refuse a call SHALL be the `tool:before` extension point.

<!-- doc-truth:ignore -->
Two fields were REMOVED to get here, and naming them is the point of this paragraph. `permission_mode`
was an Agent SDK concept — `plan`/`acceptEdits`/`bypassPermissions`, plus the
allow-all `canUseTool` hook that was documented as the seam for later per-tool gating and could not
intercept anything. The harness owns the loop and its own tool dispatch, so the mode has no meaning
here, and the retired seam was deleted rather than left exported: a seam that cannot intercept must
not exist. `allowed_tools` went with it, because it only ever pre-approved and so never disabled
anything.
<!-- doc-truth:end -->

`POST /runs` SHALL accept three additive, optional scoping fields, all defaulting to today's
behaviour when omitted (nothing disabled, no connectors, no skills):

- `disallowed_tools` — built-in tool ids to genuinely disable. The harness SHALL remove them from
  the tool set a run offers, so the model never sees them; this is the real disable, and the reason
  a pre-approval list was not.
- `connectors` — host-configured MCP server names. The harness SHALL resolve each name against
  host-owned configuration into an MCP server connection and expose its tools to the run. A
  server's command/args/url/headers/env SHALL NEVER cross from the client. A connector that is not
  configured, refuses, or hangs SHALL NOT fail the run: the run continues without it and
  `run_started` reports the failure by CLASSIFICATION (`not_configured`/`timeout`/`failed`), never
  the transport's own message, which could carry a URL with a token in it.
- `skills` — `"all"` or an array of discovered skill names. The harness SHALL index the selected
  skills in the system prompt and expose a `skill` tool that loads one on demand. Indexing rather
  than inlining is required, not stylistic: inlining every `SKILL.md` was never viable at real
  scale (79 on the measured host).

`run_started` SHALL echo the RESOLVED set — what the run actually applied, not what was requested —
because that event is the only place a client, including a late joiner arriving by backfill with no
live events, can learn what a run was allowed to do. Rails SHALL reject any value outside the
discovered/known sets with `422` before it reaches the harness.

#### Scenario: A run pins cwd to the session worktree

- **WHEN** Rails starts a run in either mode
- **THEN** the run's `cwd` is the session worktree and no permission mode is sent, because the field
  does not exist

#### Scenario: disallowed_tools removes the tool from the run entirely

- **WHEN** Rails starts a run with `disallowed_tools:["Bash"]`
- **THEN** the harness builds the run's tool set without `Bash`, so the model is never offered it,
  and `run_started` echoes `disallowed_tools:["Bash"]`

#### Scenario: A connector name is resolved server-side to an MCP server

- **WHEN** Rails starts a run with `connectors:["github"]` for a host that has a `github` MCP server
  configured
- **THEN** the harness connects to it from host-owned config and exposes its tools to the run, and no
  server configuration crosses from the client

#### Scenario: A broken connector does not break the run

- **WHEN** a selected connector is not configured on the host, refuses the connection, or hangs
- **THEN** the run proceeds without it and `run_started` lists it under `connectors_failed` with a
  classified `kind`, so the participant who enabled it is told rather than left to infer it from
  absence

#### Scenario: Skills are indexed, not inlined

- **WHEN** Rails starts a run with `skills:"all"`
- **THEN** the harness indexes the discovered skills in the system prompt and offers a `skill` tool
  that loads one on demand

### Requirement: Harness capability discovery endpoints

The harness SHALL expose read-only, `cwd`-scoped discovery that Rails proxies to the client:
`GET /connectors?cwd=<path>` and `GET /skills?cwd=<path>`. The built-in tool set is NOT discovered —
it is a shared `packages/contracts` constant, because it is the harness's own tool registry rather
than anything host-configured. Discovery SHALL read only host-owned configuration (the given repo
path plus host-wide `~/.claude`) and SHALL NOT start a run. Like every other harness route, both
SHALL require the bearer `HARNESS_SHARED_SECRET`: the harness binds host loopback, which every
process running as the developer can reach, so placement is not the boundary.

The connector listing SHALL expose only each server's `name` and `transport` — never
command/args/url/headers/env/tokens. The skills listing SHALL be derived from scanning `SKILL.md`
frontmatter (`name`, `description`). Each response SHALL pin a success shape
(`{ connectors: [...], source }`, `{ skills: [...], source }`) and SHALL degrade to an empty list
with an unavailable `source` and a `200` — never an error — when the configuration is absent or
unparseable, mirroring `GET /api/models`.

#### Scenario: Discovery reads the session repo config without starting a run

- **WHEN** Rails requests `GET /connectors?cwd=<path>` or `GET /skills?cwd=<path>` from the harness
- **THEN** the harness returns the host-configured connector names, or the scanned skills for that
  path plus `~/.claude`, without starting a run

#### Scenario: Discovery degrades safely

- **WHEN** the given repo has no MCP config or skills directory, or the files are unparseable
- **THEN** the harness returns an empty list with an unavailable `source` and a `200`, never an error

#### Scenario: Discovery is authenticated like everything else

- **WHEN** an unauthenticated process on the host calls `GET /connectors` or `GET /skills`
- **THEN** the harness answers `401`, because loopback is not the boundary

