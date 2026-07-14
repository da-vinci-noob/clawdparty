# Contract 2 — Rails ↔ sidecar protocol (the A↔B seam)

> **Status: FROZEN.** All endpoint signatures, success/error shapes, the worktree convention,
> compose-network addressing, and the auth model are frozen now (no spike dependency). Changes
> after the freeze are recorded in [`CHANGELOG.md`](./CHANGELOG.md); an endpoint-signature change
> is **breaking** (major bump).

This is the seam between `api/` (Rails) and `sidecar/` (Node + Agent SDK). Rails drives run
control; the sidecar streams results back. Every result on the sidecar→Rails side is a
[Contract-1 event envelope](./events.md) — there are no bespoke message shapes.

## 1. Addressing — no hard-coded hosts

- Rails reaches the sidecar at **`SIDECAR_URL`** (default `http://sidecar:8787` over the Docker
  compose network).
- The sidecar reaches Rails at a configurable **callback base URL** (`RAILS_INTERNAL_URL`,
  default `http://rails:3000`).

No component hard-codes a fixed host or assumes loopback, so remote/Tailscale operation remains a
future drop-in (publish/forward + origins, no app change).

## 2. Rails → sidecar (run control)

Base: `SIDECAR_URL`. These are **not** authenticated by the shared secret (they ride the private
compose network); the bearer secret guards the sidecar→Rails callbacks (§3).

### `POST /runs` — start a run

Body (at least):

| field | type | notes |
|---|---|---|
| `run_id` | string | the `ai_run_id` Rails assigned |
| `session_id` | string | |
| `repo_path` | string | the **session worktree** path; pinned as the run's `cwd` |
| `prompt` | string | the initiating prompt |
| `requested_by` | string | originating participant id — stamped as `actor.id` on `run_started` |
| `claude_session_id` | string? | optional; resume a prior Claude session (revise only) |
| `model` | string? | optional model override |
| `max_turns` | integer? | optional |
| `permission_mode` | string | `acceptEdits` (see §5) |
| `allowed_tools` | string[] | tool whitelist (see §5) |

Responses:
- **`202 Accepted`** `{ "run_id": "...", "status": "running" }` — the run proceeds
  asynchronously; events arrive via the callback (§3). The success shape is part of the frozen
  contract, not only the errors.
- **`409 Conflict`** — a run is already active for the session; the sidecar does **not** start a
  second run.

`run_started` carries `actor = { kind: "user", id: <requested_by> }`.

### `POST /runs/:id/messages` — follow-up into a live run

Body: `{ "message": "<text>", "requested_by": "<participant id>" }`.

The follow-up is **pushed into the run's live streaming-input iterable without respawning** the
run. `requested_by` is the attribution carried onto any follow-up-driven event's `actor.id`.

Responses: **`200`** `{ "run_id": "...", "accepted": true }`; **`404`** if the run is unknown;
**`409`** if the run is not in a state that accepts input.

### `POST /runs/:id/interrupt` — interrupt a live run

Body: `{ "requested_by": "<participant id>" }` — interrupt is a **human** action, so the resulting
`run_interrupted` event is attributed to that user (unlike the system-attributed
`run_finished`/`run_failed`).

Responses: **`200`** `{ "run_id": "...", "accepted": true }`; **`404`**/**`409`** when the run is
unknown or not interruptible.

### `GET /healthz` — liveness + active runs

**`200`** `{ "active_run_ids": ["run_...", ...] }`. Same key name as the heartbeat (§3) — the
concept is named once.

## 3. Sidecar → Rails (callbacks)

Base: `RAILS_INTERNAL_URL`. **Both** callbacks are authenticated with a **bearer
`SIDECAR_SHARED_SECRET`**, compared with a **constant-time comparison** to resist timing attacks
(the rule is inherited from one place by every bearer-verifying endpoint). A missing or invalid
bearer is rejected **`401`** and ingests nothing.

> The only statuses these callbacks are contract-defined to return are **`200`**, **`422`**
> (`/internal/events` malformed batch), and **`401`**. `403`/`404` are **not** contract-defined
> here — the bearer-authed internal callbacks do not run `SessionPolicy` — so a `403`/`404` can
> only mean a misconfiguration/misroute, and the sidecar MAY treat it defensively as fatal.

### `POST /internal/events` — batched, idempotent event ingest

Request body is a **named object** `{ "events": Event[] }` (not a bare top-level array — so the
envelope can carry future sibling fields additively). Each element is a Contract-1 envelope.

- Idempotent per the `(ai_run_id, seq)` rule ([events.md §5](./events.md)).
- **Best-effort per event** within a parseable batch: each valid event is upserted independently
  (duplicates skipped), so one already-persisted event does **not** reject the batch.
- **`200`** `{ "accepted": <n>, "skipped": <n> }` — `skipped` counts duplicates deduped on
  `(ai_run_id, seq)`.
- **`422`** — a **malformed** batch (unparseable body, missing `events`, or an element missing
  required envelope fields) is rejected and **ingests nothing**. (A null `id`/`seq` on an ephemeral
  event is **valid**, not malformed.)
- `409` is reserved for run-start conflicts and is **not** used by this endpoint.

### `POST /internal/sidecar/heartbeat` — every 5 s

Request body: `{ "active_run_ids": ["run_...", ...] }`. **`200`** `{ "ok": true }` on success.

## 4. Worktree convention & `base_sha`

- **Rails** creates the worktree at **`<repo>/.clawdparty/worktrees/session-<id>`** on branch
  **`clawd/session-<id>`**. The sidecar receives this path as the run's `cwd` and **must not**
  create or relocate it.
- **`base_sha`** is recorded at run start (for later diff/changeset computation).
- The worktree path **must be identical inside the Rails and sidecar containers** (both
  bind-mount the target repo at the same path) — git worktrees record absolute `.git` paths.

## 5. Permission mode & tool scoping at run start

Every run starts with **`permission_mode: acceptEdits`**, an **`allowed_tools`** whitelist, and
**`cwd` pinned to the session worktree**. The `canUseTool` permission hook is **allow-all for the
MVP** and is documented as the seam for later per-tool Bash gating.
