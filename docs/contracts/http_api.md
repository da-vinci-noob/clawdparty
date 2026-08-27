# Contract 3 — Client-facing REST + cable API

> **Status: FROZEN.** Endpoint surface, response-shape conventions, the cable mount + rule, the
> 4-role matrix, the auth model, and the catch-up algorithm are frozen now (no spike dependency).
> Changes after the freeze are recorded in [`CHANGELOG.md`](./CHANGELOG.md).

This is the surface the browser (`web/`) builds against. **Every live update arrives as a
[Contract-1 event envelope](./events.md) over the cable — there are no bespoke cable message
types.** Diffs are the one large payload that goes over **REST, never cable**.

## 1. Response-shape conventions (pinned once)

- **Success** shapes are per-endpoint (below).
- **Errors** are always `{ "errors": [ { "message": "<human-readable>", ... }, ... ] }`. Each
  element is an object with at least a `message` string; additional fields (e.g. a `code`) MAY be
  added **additively**. This matches the Rails `rescue_from` → `render json: { errors }`
  convention and makes every role-gated endpoint testable the same way.

### `403` vs `404` — the anti-enumeration rule

| situation | status |
|---|---|
| A **participant of the session** requests an action their **role** does not permit | **`403`** `{ errors }` |
| A requester accesses a session they are **not a participant of**, OR presents an **invalid/expired/revoked invite token**, OR a genuinely nonexistent resource | **`404`** `{ errors }`, **indistinguishable** from each other |

`404` never confirms existence (anti-enumeration / IDOR). `403` is reserved for the known
participant whose action is denied. Downstream specs (`invite-auth`, `event-ingest-pipeline`)
implement this convention; it is pinned here as the single source.

## 2. REST endpoint surface

| area | endpoint(s) |
|---|---|
| session | create / join |
| **session history** | `GET /api/sessions` (the caller's sessions — host or participant) |
| **session archive** | `POST /api/sessions/:id/archive` (owner hard-close) |
| invites | generate / use |
| run | start `POST /api/sessions/:id/runs` |
| run input | follow-up · interrupt |
| **capability discovery** | `GET /api/sessions/:id/connectors` · `GET /api/sessions/:id/skills` |
| **auth test** | `POST /api/providers/verify` |
| **host AWS profiles** | `GET /api/aws-profiles` |
| **skill management** (owner) | `POST /api/sessions/:id/skills` · `DELETE /api/sessions/:id/skills/:name` |
| **event backfill** | `GET /api/sessions/:id/events?after=<cursor>` |
| **projection repair** | `GET /api/sessions/:id/projection/check` · `POST /api/sessions/:id/projection/rederive` (owner) |
| **diff** | `GET /api/runs/:id/diff` (REST only) |
| changeset | approve · reject |
| files | tree · content read |

### Session history — `GET /api/sessions`

A **per-user index** (not scoped to one session): returns **`200`** with an array of the caller's
sessions — every session they **host** or **participate in**, de-duplicated, ordered by
`last_activity_at` **descending**. Each row is
`{ id, title, mode, status, my_role, last_activity_at, created_at }` (`id` a string; `status` one
of `active`/`archived`; `my_role` the caller's role, or `owner` when host without a participant
row). Gated only by a valid `clawd_uid`; an unauthenticated request is **`404`** `{ errors }` (the
shared `require_user` anti-enumeration posture — not a distinct `401`).

### Session archive — `POST /api/sessions/:id/archive`

**Owner-only** (per the matrix below). Transitions the session `active → archived` and returns
**`200`** `{ id, status: "archived" }`; **idempotent** (re-archiving is a `200` no-op). Archive is
a **hard close** — `archived` is terminal (no un-archive) and starting a run on an archived session
is refused with **`409`** `{ errors }`. A non-owner participant is `403`; a non-participant/unknown
session is `404`.

### Event backfill — `GET /api/sessions/:id/events?after=<cursor>`

Returns **`200`** with an **ordered array of Contract-1 event envelopes**, every element having
`id` **greater than** `<cursor>`, in **ascending `id`** order. The catch-up algorithm relies only
on the envelope cursor (`id`) and dedupe-by-`id` for durable events.

### Projection repair — `GET /api/sessions/:id/projection/check` · `POST .../rederive`

`events` is a **projection** of the harness's store, so a gap in it — a Rails outage, a
ring-buffer overflow the harness reported as genuine loss — is repairable rather than lost.

`check` is read-only and returns both sides so a divergence can be read rather than guessed:
`{ diverged, reason, rails: { high_water, count }, harness: { high_water, count } }`. `reason`
is one of `missing_batch` (Rails is behind), `unexpected_rows` (Rails has rows the record does
not), `content_mismatch` (same high water mark, different content — a mutated or duplicated
row), or `null`. **It never repairs what it finds**: a silent auto-heal destroys the evidence.

`rederive` defaults to **gap-fill** — replay from Rails' own `max(store_seq)`, additive, and
broadcast because those events are genuinely unseen. `reset: true` deletes the rows the record
can rebuild — those with a `store_seq` — and replays the whole log; it does **not** broadcast,
because the rebuilt rows get new `id`s and re-broadcasting would defeat the client's
dedupe-by-id and replay the session into every open feed. A client whose cursor spans a reset
must reload.

Rows Rails appended itself (`chat_message`, `changeset_approved`/`rejected`,
`participant_joined`) have no `store_seq` and are **preserved**: no harness entry exists to put
them back, so deleting them destroyed the chat and the review audit trail permanently. They
keep their old, lower `id`s, so after a reset a mid-session chat message sorts before the
transcript in an `id`-ordered feed. `ts` stays correct.

**Owner-only.** Rebuilding the room's history is a session-management action, not a review
action: an editor can drive Claude and still cannot rewrite what the room saw.

### Diffs are REST-only

A run's diff is fetched at `GET /api/runs/:id/diff`. **No diff payload is delivered over cable.**

### Run start — capability selection (additive)

`POST /api/sessions/:id/runs` accepts three optional body fields alongside `prompt` / `model` /
`permission_mode`, each defaulting to today's behavior when omitted:

- `disallowed_tools: string[]` — built-in tool ids to turn OFF (validated ⊆ the shared
  `BUILTIN_TOOLS` constant, whose ids are the harness's own registry names — `read`, `bash`,
  `str_replace_based_edit_tool` — never the Agent SDK's `Read`/`Bash`, which nothing answers to; see
  CHANGELOG 1.8.0),
- `connectors: string[]` — host-configured MCP server names to enable (validated ⊆ the session's
  discovered connectors),
- `skills: "all" | string[]` — skills to enable (`"all"` or validated ⊆ discovered skills).

An unknown/non-selectable value is refused **`422`** `{ errors }` and starts no run; when discovery
is unavailable, validation **fails open** (the harness is the backstop). Setting these follows the
existing **start-run** role gate (owner/editor) — a reviewer/viewer is **`403`** `{ errors }`. On
success the run returns its existing **`202`** shape. The `run_started` event echoes the resolved
selection.

### Capability discovery — `GET /api/sessions/:id/connectors` · `GET /api/sessions/:id/skills`

Read-only, **session-scoped** (the repo is per-session), proxied from the harness and cached like
model discovery (cache key includes the repo path). Return **`200`** with
`{ connectors: [{ name, transport }], source }` and `{ skills: [{ name, description }], source }`
respectively — an empty list with an unavailable `source` when the repo has no config, and **`502`**
when the harness is unreachable. Any participant may read them; a non-participant/cross-session
request is **`404`** `{ errors }`. Connector responses never contain a server's
command/url/headers/tokens. The built-in **tools** list is the shared `BUILTIN_TOOLS` constant, not
an endpoint.

### Session run defaults — `PATCH /api/sessions/:id`

**OWNER only** (`manage_session`), and now accepts `default_provider`, `default_model`, `aws_profile`
and `title` alongside the existing `repository_path`. Returns the session, which `GET
/api/sessions/:id` also exposes to **every** participant: which provider a run uses and which account
pays are facts about the room, not owner secrets — only the writing is gated.

**Only the keys present are touched.** The endpoint recomputes the working directory *only* when
`repository_path` is sent, because `working_directory` defaults to the repo root when blank — so
recomputing on every PATCH would move a session's directory the moment someone set a provider default.

An empty string **clears** a default (stored as NULL): "no default, resolve one at run start" has to
stay reachable. Validation follows the capability-selection rule (design D6) — only a value outside a
**known, non-empty** set is **`422`**, so a harness outage cannot block a settings change. A model is
checked against **its own provider**, never the union, because a model id only means something
relative to the provider serving it.

`aws_profile` is validated against `GET /api/aws-profiles` (names only, never a credential value —
) and decides **whose account pays**.

**The defaults are what a run starts with**: `POST /api/sessions/:id/runs` resolves
explicit param → session default → built-in, so the composer's per-run pick still wins.

### Skill management — `POST /api/sessions/:id/skills` · `DELETE /api/sessions/:id/skills/:name`

**OWNER only** (`manage_session`). The app's only writes outside a session worktree, and treated as
such because a skill is *instructions Claude will follow* — adding one is closer to granting a
capability than to editing a document.

`POST` takes `{ scope: "project" | "host", name, description, body, replace? }` and returns **`201`**.
`scope` defaults to **`project`**, never `host`: a host skill reaches every session on the machine and
the developer's own terminal Claude Code, so the larger blast radius is asked for explicitly. An
existing name is **`422`** unless `replace: true`. The harness validates `name` as a strict single
lowercase segment BEFORE touching the filesystem, so a write cannot land outside the chosen root;
a refused name is **`422`** with an actionable message.

`DELETE` takes `?scope=` and **does not delete**: the harness moves the directory to a sibling
`.claude/skills-removed/`, so an unwanted removal is recoverable on disk — the same reasoning as
`bin/harness reset-session`. Moving it OUT of `skills/` rather than renaming it in place is
load-bearing: discovery keys on the frontmatter `name`, so a renamed directory stayed listed, stayed
in every run's skill index, and stayed loadable. A name absent from that scope is **`404`**.

Both append a **`skill_changed`** event attributed to the acting participant, because who changed
what the room can do belongs in its timeline rather than only in a file's mtime.

### Auth test — `POST /api/providers/verify`

Does each provider ACTUALLY work, right now? Returns **`200`**
`{ providers: [{ id, displayName, ok, model?, credentialSource?, reason?, remedy?, error?, usage?,
durationMs? }] }`, proxied from the harness's `POST /verify`.

**A POST, because it is not a read**: the harness sends one minimal (1-token) real request per
provider through the same adapter path a run uses. That is the point — `GET /api/models` reports
PRESENCE (a credential and a region were found), which is not the claim "a run would be accepted".
Two measured counter-examples: `us.amazon.nova-premier-v1:0` is refused on entitlement with a
perfectly valid credential, and a correctly-configured MCP server answered `invalid_token`. A
settings tab built on presence alone reports both as fine.

`credentialSource` is a NAME (`env:AWS_PROFILE`, `profile:active`) and never a value .
`error` is the provider's OWN message, because "AccessDeniedException" or "expired" is the entire
diagnostic and paraphrasing discards the actionable part. `usage` reports what the check spent, so
the cost is stated rather than implied.

Readable by **any participant**, like `GET /api/models`: the route is not session-nested (providers
are host-wide, so there is no session to view-gate against) and a viewer who cannot diagnose a
provider failure has to ask someone else to look. **Never cached** — the reason to run it is that
something just changed. **`502`** `{ errors }` when the harness is unreachable.

## 3. Cable — `/~cable`, one envelope shape

- The ActionCable mount is **`/~cable`**.
- A client opens the realtime connection and **subscribes to the session channel**.
- **Every** broadcast is a Contract-1 envelope — **no custom cable message shapes**.
- The server **independently verifies participantship** before allowing a subscription (the
  client only hides buttons; the server enforces).

## 4. The 4-role permission matrix (server-enforced)

| action | owner | editor | reviewer | viewer |
|---|:---:|:---:|:---:|:---:|
| view / event backfill / read diffs & files | ✓ | ✓ | ✓ | ✓ |
| list own sessions (`GET /api/sessions`) | ✓ | ✓ | ✓ | ✓ |
| send `chat_message` | ✓ | ✓ | ✓ | ✓ |
| create / update tasks | ✓ | ✓ | ✓ | ✗ |
| start run / send follow-up / interrupt | ✓ | ✓ | ✗ | ✗ |
| approve / reject changeset | ✓ | ✓ | ✓ | ✗ |
| archive session | ✓ | ✗ | ✗ | ✗ |
| check / re-derive the projection | ✓ | ✗ | ✗ | ✗ |

(owner = everything incl. runs + approve/reject + invites/archive; editor =
runs/follow-ups/interrupt + tasks/chat + approve/reject; reviewer = tasks/chat/view +
approve/reject; viewer = view/chat. Approve/reject is available to everyone except
viewer; only owner/editor can drive Claude, and only owner manages invites/archive.)

The server enforces this matrix on **every** endpoint; cable subscriptions independently verify
participantship. The client only hides buttons. A denied action for a **participant** returns
`403 { errors }` (§1); cross-session/unknown access returns `404`.

## 5. Authentication — one cookie for REST and cable

A role-scoped **reusable invite link** is exchanged for a **signed httpOnly cookie**
(`clawd_uid`), with **no `Secure` flag** on the plain-HTTP LAN. The **same cookie** authenticates
both REST requests and the ActionCable connection.

## 6. Gap-free late-joiner catch-up

The catch-up sequence (lives in `web/src/lib/cable.ts`):

1. **Subscribe** to the cable channel **first**.
2. **Buffer** live events as they arrive.
3. **Backfill** via `GET /api/sessions/:id/events?after=<cursor>`.
4. **Drain** the buffer: apply **durable** (non-null `id`) events only when `id` is **greater
   than the max backfilled `id`**; **always apply ephemeral (null-`id`) events** — a null `id` is
   not `> max`, so a literal filter would wrongly drop ephemeral events buffered during catch-up.
5. Go **live**.

Stores **dedupe durable events by `id`**; **ephemeral events (null `id`) are exempt** — deltas
accumulate by `(ai_run_id, block)`, presence is last-writer-wins per participant. The algorithm
relies only on the envelope cursor and dedupe-by-`id`; no missed or duplicated events.
