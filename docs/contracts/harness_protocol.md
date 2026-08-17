# Contract 2 — Rails ↔ harness protocol (the A↔B seam)

> **Status: FROZEN.** All endpoint signatures, success/error shapes, the worktree convention,
> compose-network addressing, and the auth model are frozen now (no spike dependency). Changes
> after the freeze are recorded in [`CHANGELOG.md`](./CHANGELOG.md); an endpoint-signature change
> is **breaking** (major bump).

This is the seam between `api/` (Rails) and `harness/` (Node + Agent SDK). Rails drives run
control; the harness streams results back. Every result on the harness→Rails side is a
[Contract-1 event envelope](./events.md) — there are no bespoke message shapes.

## 1. Addressing — no hard-coded hosts

- Rails reaches the harness at **`HARNESS_URL`** (default `http://harness:8787` over the Docker
  compose network).
- The harness reaches Rails at a configurable **callback base URL** (`RAILS_INTERNAL_URL`,
  default `http://rails:3000`).

No component hard-codes a fixed host or assumes loopback, so remote/Tailscale operation remains a
future drop-in (publish/forward + origins, no app change).

## 2. Rails → harness (run control)

Base: `HARNESS_URL`. These are **not** authenticated by the shared secret (they ride the private
compose network); the bearer secret guards the harness→Rails callbacks (§3).

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
| `permission_mode` | string | one of `plan` / `acceptEdits` / `bypassPermissions`; default `acceptEdits` when omitted (see §5) |
| `disallowed_tools` | string[]? | built-in tool ids to hard-disable (→ SDK `disallowedTools`; see §5). Omitted = nothing disabled |
| `connectors` | string[]? | host-configured MCP server names to enable (see §5). Omitted = none |
| `skills` | `"all"` \| string[]? | discovered skills to enable (see §5). Omitted = none |

Responses:
- **`202 Accepted`** `{ "run_id": "...", "status": "running" }` — the run proceeds
  asynchronously; events arrive via the callback (§3). The success shape is part of the frozen
  contract, not only the errors.
- **`409 Conflict`** — a run is already active for the session; the harness does **not** start a
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

### `GET /runs` — the authoritative active-run list

**`200`** `{ "runs": [{ "run_id", "session_id", "lane", "store_seq" }] }`, read from the
`run.position` registers rather than inferred from the log.

This is the ** reconciliation source**: on boot Rails calls it and reconciles
`ai_runs` to the answer. **The harness wins**, because it holds the record and Rails holds
a projection of it.

> **`POST /runs/:id/permission_mode` was REMOVED** (CHANGELOG B2). Permission modes were an
> Agent SDK concept; the gate is now `tool:before` (§5). Supplying the old route gets a
> `404`, and a test asserts that — a removal nothing tests is a removal that comes back.

### `GET /healthz` — liveness + active runs

**`200`** `{ "active_run_ids": ["run_...", ...] }`. Same key name as the heartbeat (§3) — the
concept is named once.

## 3. Harness → Rails (callbacks)

Base: `RAILS_INTERNAL_URL`. **Both** callbacks are authenticated with a **bearer
`HARNESS_SHARED_SECRET`**, compared with a **constant-time comparison** to resist timing attacks
(the rule is inherited from one place by every bearer-verifying endpoint). A missing or invalid
bearer is rejected **`401`** and ingests nothing.

> The only statuses these callbacks are contract-defined to return are **`200`**, **`422`**
> (`/internal/events` malformed batch), and **`401`**. `403`/`404` are **not** contract-defined
> here — the bearer-authed internal callbacks do not run `SessionPolicy` — so a `403`/`404` can
> only mean a misconfiguration/misroute, and the harness MAY treat it defensively as fatal.

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

### `POST /internal/harness/heartbeat` — every 5 s

Request body: `{ "active_run_ids": ["run_...", ...] }`. **`200`** `{ "ok": true }` on success.

## 4. Worktree convention & `base_sha`

- **Rails** creates the worktree at **`<repo>/.clawdparty/worktrees/session-<id>`** on branch
  **`clawd/session-<id>`**. The harness receives this path as the run's `cwd` and **must not**
  create or relocate it.
- **`base_sha`** is recorded at run start (for later diff/changeset computation).
- The worktree path **must be identical inside the Rails and harness containers** (both
  bind-mount the target repo at the same path) — git worktrees record absolute `.git` paths.

## 5. Tool scoping and the command gate at run start

**`permission_mode` is GONE** (CHANGELOG B2). It was an Agent SDK concept: the SDK owned
the loop, so the mode was the only lever over what a tool call could do. The harness owns
the loop now, so the lever is the **`tool:before` extension point** plus the per-run tool
set — both of which are ours and both of which are testable.

**`allowed_tools` is GONE too** (CHANGELOG), and for a sharper reason: it was not merely
superseded, it was never read. The harness accepted the field from the day the SDK left and no code
path consulted it, so Rails computed and sent a whitelist that changed nothing. An allow-list only
*pre-approves* in any case — the two things that actually bound a tool call are the `tool:before`
gate and dropping a declaration outright (`disallowed_tools`).

**`cwd` is still pinned to the session worktree.**

### The four extension points

Named places in the loop where registered code observes, transforms, or refuses work.
`tool:before` is the command gate — the role `permissions.ts` was documented as filling
and never could, because nothing imported it .

| Point | Signature | May |
|---|---|---|
| `request:before` | `(RequestCtx) => Outcome<RequestCtx>` | rewrite the claimed messages, or refuse the turn |
| `tool:before` | `(ToolCallCtx) => Outcome<ToolCallCtx>` | **refuse or transform a tool call** |
| `tool:after` | `(ToolResultCtx) => Outcome<ToolResultCtx>` | transform the result the model sees |
| `run:complete` | `(RunOutcomeCtx) => void` | **observe only** — nothing left to refuse, and failing the terminal transaction would strand the run |

`Outcome<T>` is `continue` (pass through, possibly transformed) · `refuse` (deny, surfaced
as `tool_refused`) · `replace` (short-circuit with a substitute).

### Resolution order

Priority **bands**, ascending; registration order **within** a band:

| Band | Priority |
|---|---|
| bundled | `0` |
| first-party plugin | `50` |
| third-party plugin | `100` |

**Never load order**. Load order is an accident of the filesystem, so a
conflict resolved by it resolves differently on someone else's machine.

- **Refusal wins** and short-circuits; a later handler cannot un-refuse.
- **Transforms compose** — `continue` passes the transformed value onward.
- **`replace` short-circuits**; remaining handlers are skipped.
- **Failure is contained** — a throw is caught, logged with the contributor's identity,
  and treated per the table below. It never terminates the run .
- **Removal is total** — unregistering clears every binding *and* the strike history, so
  a re-enabled plugin is not disabled by a previous session .

### Time bounds and what happens on expiry

| Point | Bound | On timeout or throw |
|---|---|---|
| `request:before` | 5s | `continue` |
| **`tool:before`** | **30s** | **`refuse` — FAILS CLOSED** |
| `tool:after` | 5s | `continue` |
| `run:complete` | 5s | `continue` |

`tool:before` gets 30s because it may await a human approval, and it fails **closed**.
That asymmetry is the one worth stating outright: a hung approval gate must not silently
permit the command it was installed to gate. A fail-closed refusal names the handler that
broke, so it does not read as the model being blocked for no reason.

**Three failures or timeouts in one session auto-disables that contributor** for the
session and records it . It stops being invoked at all, rather than being invoked
and ignored.

### The bundled reference rule is not a security boundary

`harness/src/extensions/rules/deny_destructive_bash.ts` catches the obvious accident —
`rm -rf /`, force-push, `curl | sh`, scraping `env` for credentials. It cannot be
exhaustive: `$(printf 'r''m') -rf /` gets through, and there is a test asserting that it
does, so nobody reads the deny-list and concludes otherwise. Containment is the worktree,
the realpath path rules, and human review.

### Per-run tool / connector / skill scoping (additive)

`POST /runs` additionally accepts three optional, additive fields, each defaulting to today's
behavior when omitted:

- **`disallowed_tools`** — built-in tool ids the user turned OFF. An allow-list only *pre-approves*,
  so the **only true disable** is dropping the declaration, which is what the harness does: the
  registry withholds those tools from the request entirely. **Ids are the harness's own registry
  names** (`read`, `bash`, `str_replace_based_edit_tool`) — see CHANGELOG 1.8.0, where they were the
  Agent SDK's capitalized names that nothing answered to, making the whole field a no-op.
- **`connectors`** — host-configured MCP **server names** to enable. The harness IS the MCP client
  (CHANGELOG 1.9.0): it resolves each name against host-owned config (the session repo's `.mcp.json`
  + `~/.claude.json`), connects (stdio / streamable HTTP / SSE), calls `tools/list`, and registers
  each tool as `mcp__<server>__<tool>` in that RUN's registry — so MCP tools flow through the same
  `tool:before` gate, `tool_started`/`tool_finished` events, and `disallowed_tools` filter as the
  built-ins. The client **never** supplies a server's command/url/headers — only names; an unknown
  name is rejected by Rails (`422`) and, if it reaches the harness, reported as `not_configured`.
  A server that fails or hangs (bounded at 10s) does **not** fail the run.
- **`skills`** — `"all"` or discovered skill names. The harness composes them itself now that the
  SDK's `settingSources` is gone, by PROGRESSIVE DISCLOSURE rather than inlining: the system
  prompt gains a one-line INDEX (name + description, each clipped to 200 chars) and the run gains a
  `skill` tool whose `name` enum is exactly the resolved skills, so a body is loaded only when the
  model decides one applies. Measured on a host with 57 skills: the index + tool schema cost **~4,000
  input tokens per turn** (5,864 vs 1,867 for the identical run with `skills: []`), against roughly
  140,000 to inline every body. A selected name the host does not have is dropped, never indexed —
  the model is never told about a skill it cannot load. The `skill` tool takes a NAME and looks it up
  in a map built by the harness's own scan, and the body read is realpath-contained to that skill's
  root, so a symlinked `SKILL.md` cannot turn the skills directory into a reader for arbitrary files.

The `run_started` event echoes the **resolved** `disallowed_tools` / `connectors` / `skills`
(additive optional payload fields, `CONTRACT_VERSION` 1.4) so the UI reflects a run's real scope,
plus **`connectors_failed`** (`1.9`) — the selected servers that did not load, each with a
CLASSIFICATION (`not_configured` / `timeout` / `failed`) rather than the transport's own message,
which could carry a URL with a token in it. `connectors` lists only what actually loaded.

### Skill writes — `POST /skills` · `POST /skills/remove`

The only harness routes that MUTATE host files. Rails owner-gates them; the harness lands them.

`POST /skills` takes `{ cwd, scope, name, description, body, replace? }`. The name is validated as a
strict single lowercase segment **before** anything touches the filesystem — that is what makes the
write incapable of landing outside `<cwd>/.claude/skills` (scope `project`) or `~/.claude/skills`
(scope `host`), rather than a check applied afterwards. The description is written as a YAML **block
scalar** with every line indented, so a newline (or a line reading `---`) in free text cannot rewrite
the skill's own frontmatter. An existing name is **`422`** unless `replace: true`.

`POST /skills/remove` is a POST because it does not delete: the directory is MOVED to a sibling
`.claude/skills-removed/<name>` (then `-2`, `-3`…, so an earlier removal is never clobbered).
Moving it out of `skills/` rather than renaming in place is the whole point — discovery keys on the
frontmatter `name`, so a `deploy.removed` directory stayed discovered, indexed and loadable.

### Discovery (read-only, `cwd`-scoped)

The harness exposes two read-only discovery endpoints Rails proxies (the built-in **tools** set is a
shared `packages/contracts` constant, not discovered):

- **`GET /connectors?cwd=<path>`** → **`200`** `{ "connectors": [{ "name", "transport" }], "source" }`
  — MCP servers configured for that repo path + `~/.claude`; **name + transport only** (never
  command/url/headers/env/tokens).
- **`GET /skills?cwd=<path>`** → **`200`** `{ "skills": [{ "name", "description" }], "source" }` —
  from scanning `<cwd>/.claude/skills/*/SKILL.md` + `~/.claude/skills/*/SKILL.md` frontmatter.

Neither starts a run. Missing/unparseable config degrades to an empty list with an unavailable
`source` (still `200`); it never throws.
