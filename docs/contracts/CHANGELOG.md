# Contracts CHANGELOG

The frozen interface contracts ([`events.md`](./events.md),
[`harness_protocol.md`](./harness_protocol.md), [`http_api.md`](./http_api.md)) and the shared
types ([`packages/contracts/src/events.ts`](../../packages/contracts/src/events.ts)) are the
seams that let the `api/`, `harness/`, and `web/` streams build independently. **Once frozen,
nothing changes silently — every change is an entry here.**

## Governance — additive is cheap, the envelope is loud

| change | classification | what it requires | version |
|---|---|---|---|
| Add a new **event type** | additive | a CHANGELOG entry; bump `CONTRACT_VERSION.minor` | `minor +1` |
| Add a new **optional field** to a payload | additive | a CHANGELOG entry; bump `minor` | `minor +1` |
| Finalize a `pending-spike` **payload** schema | additive | a CHANGELOG entry; bump `minor` | `minor +1` |
| Change the **envelope** shape (add/remove/rename a field, change a scalar type) | **breaking** | a **breaking** entry; treated as an **emergency**; bump `major` (reset `minor` to 0) | `major +1` |
| Change a frozen **endpoint signature** (path, method, request/response shape, status) | **breaking** | a **breaking** entry; emergency; bump `major` | `major +1` |
| Remove or rename an **event type** | **breaking** | a **breaking** entry; emergency; bump `major` | `major +1` |

`CONTRACT_VERSION` is `{ major, minor }` in `events.ts`. A consumer asserts compatibility by
requiring an **exact `major`** and a **`minor` ≥** what it needs — so a breaking `major` bump
fails the assertion rather than slipping through a loose `≥`, while an additive `minor` bump
stays compatible.

The freeze-now vs spike-gated boundary is documented in [`events.md §9`](./events.md). Replacing
a `pending-spike` payload marker with a concrete schema is **additive** (a `minor` bump), not
breaking — downstream code treated the payload as opaque and keeps working.

---

## ⚠️ MIGRATION WINDOW — OPEN (harness architecture)

**Opened: 2026-08-16.** **Must close by: 2026-09-15.** **Signed off: 2026-08-16.** Status: **OPEN — breaking
changes permitted.** Change: `001-harness-harness-architecture`.

This is the first and intended-only declared window in the project's life. Per ,
breaking interface changes are permitted **only** inside it; outside it, changes are
additive or they are defects. Per  the rename rides in the same window as the
protocol breaks, so the coordination cost is paid once instead of twice.

**The close date is a deadline, not a forecast.** `plan.md` sequences milestones
(M-1 → M7) but assigns no calendar dates, so 30 days is a bound chosen here to make the
window falsifiable — a window that cannot be breached is not a window. Move it
deliberately if M0 needs longer; do not let it lapse silently. **A follow-up writes the closing
entry** with the real ship date and the final list of what actually shipped.

Every breaking change below is foreseen **now**, and all of them land in **M0**
(`harness_http.md` → Compatibility and sequencing). Anything discovered later that would
break a contract *outside* this window is a defect, not an amendment (Principle I).

### Breaking — endpoint & protocol signatures

| # | Change | Streams |
|---|---|---|
| B1 | **`POST /runs` request shape** — gains `lane`, `provider`, `effort`; **drops `claude_session_id`**. Resumption becomes harness `session_id` + lane, because the harness now owns the session record. | api, harness |
| B2 | **`POST /runs/:id/permission_mode` REMOVED** — an Agent SDK concept with no meaning once we own the loop. Replaced by extension-point policy (`tool:before`) plus the per-run tool set. **The web app must stop calling it and stop rendering the mid-run switch**. | api, harness, web |
| B3 | **`GET /models` response shape** — becomes `{ providers: [{ id, available, reason?, remedy?, credentialSource?, models: [...] }] }`. Never 500s; an unavailable provider is *reported*, not omitted. | api, harness, web |
| B4 | **`POST /internal/harness/heartbeat`** body gains `store_seq_high_water` per active run, so Rails can detect projection lag without polling. | api, harness |
| B5 | **One-active-run-per-session is lifted** (M7) — the partial unique index on `ai_runs` gives way to one-active-run-per-**lane**. A client that assumed at most one active run per session is wrong afterwards. | api |

### Additive, riding the same window

- **Eight new event types** — `request_header`, `context_compacted`, `context_usage`,
  `tool_refused`, `plugin_enabled`, `plugin_disabled`, `provider_error`,
  `recovery_applied`. `CONTRACT_VERSION` `{1,4}` → `{1,5}`; `EVENT_TYPE_COUNT` 22 → 30.
  Recorded in its own entry below.
- **New endpoints** — `GET /runs` (the authoritative active-run list, and the
  reconciliation source), `GET /plugins`, `POST /sessions/:id/plugins`,
  `GET /sessions/:id/entries?after=<store_seq>`.
- **`POST /internal/events`** keeps its wire shape and gains `store_seq` per event. Its
  *role* changes from the record to a projection channel — invisible to clients, which is
  what keeps M0 behaviour-neutral.

### Breaking — deployment topology (B6)

| # | Change | Streams |
|---|---|---|
| B6 | **The harness is no longer a container.** It runs as a host process on loopback ; `docker-compose.yml` drops the `harness` service and Rails reaches it at `HARNESS_URL=http://host.docker.internal:8787`. **Every harness control route now requires a bearer `HARNESS_SHARED_SECRET`, `/healthz` included** — previously the private compose network was the only thing standing between a caller and the control surface, and on the host that is no longer true . An unauthenticated caller gets `401`. | api, harness |

Listed as breaking rather than additive because a caller that reached the harness
without a bearer stops working — even though no *payload* shape changed. Two knock-on
decisions worth stating rather than leaving to be inferred:

- **`~/.claude` and `~/.aws` bind mounts are gone**, and with them the macOS caveat that
  subscription/enterprise OAuth needed `claude setup-token` +
  `CLAUDE_CODE_OAUTH_TOKEN`: the Keychain is now readable directly. The env var stays
  supported as an explicit override and still wins its precedence slot. `aws sso login`
  freshness is unchanged — nothing can refresh that token on the developer's behalf.
- **`docker/harness.Dockerfile` and its entrypoint are DELETED.** Not kept for CI: the `harness` CI
  job already runs on a bare ubuntu runner with `actions/setup-node`, so the image was used by
  nothing once the compose service went. Keeping it would also have been actively misleading,
  because the harness now *refuses to start* inside a container . The entrypoint's
  `~/.claude.json` startup snapshot went with it — that existed only because a
  single-file bind mount breaks when the app atomically rewrites the file, and discovery
  now reads the real path.

`CONTRACT_VERSION` is unchanged by B6, consistent with the precedent recorded in the
governance question below: it versions the *event* contract, and B6 changes neither the
envelope nor the taxonomy.

### Breaking — harness store schema (B7)

| # | Change | Streams |
|---|---|---|
| B7 | **`STORE_SCHEMA_VERSION` 1 → 2.** `entries` gains `settlement_key TEXT` with `UNIQUE (run_id, settlement_key)`, and the position marker's `reservedEntrySeq` becomes `settlementKey`. An existing session store is REFUSED at open with `incompatible_version` rather than misread , so any store written before this is unreadable. | harness |

Not a client-visible contract change — no event, envelope or endpoint moves — but it is
recorded here because it makes existing records unopenable, which is the same practical
break. Acceptable inside the window on the stated basis that this is a fresh setup with no
sessions to preserve.

The reason it was necessary: reserving a `seq` up front is unsound. `seq` has exactly one
allocator (the normalizer, which says so in its own header), so reserving from a second
one handed the same ids to the turn's own entries and `UNIQUE (run_id, seq)` rejected the
settlement — **the constraint that exists to stop a second settlement was silently
blocking the first**, leaving a `tool_use` with no `tool_result` and a session the provider
would refuse to continue. A settlement key is NULL on ordinary entries, so it cannot
collide by construction. Found by the crash-injection gate, invisible to every other
test because the happy path never settles under a reserved id.

### ⚠️ Unreconciled governance question (raised, not decided)

The table at the top of this file says a frozen **endpoint signature** change is breaking
and bumps `CONTRACT_VERSION.major`. Two prior entries — `[protocol]` and `[http-api]` —
did the opposite, holding `CONTRACT_VERSION` still on the grounds that it versions the
*event* contract, not the protocol. **This entry follows that precedent**: B1–B5 change
endpoint signatures and `CONTRACT_VERSION.major` stays at 1.

The consequence is worth stating plainly rather than leaving implicit: **B1–B5 ship with
no machine-detectable version signal.** A consumer cannot assert its way out of them; it
finds out at runtime. That is tolerable only because this window is declared and
coordinated by sign-off. Either the governance table's endpoint row or the precedent is
wrong, and reconciling them is a **separate decision** — not something this entry settles.

### Sign-off — all three streams, before M0 merges

Each stream signs that it has read B1–B5 + the rename table and has its side scheduled.

- [x] **api** — signed: Shah Rukh &lt;shahrukh@hackerone.com&gt; date: 2026-08-16
- [x] **harness** — signed: Shah Rukh &lt;shahrukh@hackerone.com&gt; date: 2026-08-16
- [x] **web** — signed: Shah Rukh &lt;shahrukh@hackerone.com&gt; date: 2026-08-16

**One maintainer signed all three streams, and that is worth stating rather than
leaving implied.** 's sign-off exists to force *coordination between
independent parties*; with a single maintainer it cannot do that job, so what these
three boxes attest to is narrower: that the breaking set was enumerated before any of
it shipped, and that each affected stream has an owning task. They are not three
independent reviews.

Verified per change rather than asserted — every stream a break touches has an owner:

| Change | api | harness | web |
|---|---|---|---|
| B1 `POST /runs` shape | ✓ | ✓ | — |
| B2 `permission_mode` removed | ✓ | ✓ | **✓** |
| B3 `GET /models` shape | ✓ | ✓ | ✓ |
| B4 heartbeat rename + `store_seq_high_water` | ✓ | ✓ | — |
| B5 one-active-run lifted (M7) | ✓ | ✓ | — |
| Rename  | ✓ | ✓ | — |

**What this sign-off does NOT cover**, so a later reader does not over-read it: the
two items still unverified at signing are the six-field Solid Queue cron
(needs a live dispatcher) and `bin/check-docs` reaching green (4 genuine findings
remain, each owned by a follow-up). Neither is a contract break; both are tracked.

## [1.5.0] — harness event taxonomy (additive)

**`CONTRACT_VERSION = { major: 1, minor: 5 }`.** Additive `minor` bump
(`001-harness-harness-architecture`): eight new event types so the harness's own
behaviour — what it sent, what it refused, what it recovered, what it compacted — is
visible in the same stream as everything else. Rides the migration window above but is
**not** itself breaking: the envelope, the existing 22 names, and every existing payload
are untouched.

### Added (additive — nothing removed or renamed)

| type | actor | durability | scope | payload | serves |
|---|---|---|---|---|---|
| `request_header` | system | durable | run | `{ provider, credential_source, model, effort, system_prompt_digest, tool_schemas_digest, plugins[] }` |  |
| `context_compacted` | system | durable | run | `{ replaced_from_seq, replaced_to_seq, tokens_before, summary_present }` |  |
| `context_usage` | system | **ephemeral** | run | `{ input, output, cache_read, cache_creation, window }` |  |
| `tool_refused` | system | durable | run | `{ tool_use_id, name, by, reason }` | , /AC1 |
| `plugin_enabled` | **user** | durable | **session** | `{ id, version, origin, by }` |  |
| `plugin_disabled` | **user** | durable | **session** | `{ id, version, origin, by }` |  |
| `provider_error` | system | durable | run | `{ provider, kind, message, remedy }` |  |
| `recovery_applied` | system | durable | run | `{ run_id, from_phase, action, uncertain }` | , /AC4 |

- **`EVENT_TYPE_COUNT`** freeze guard updated **22 → 30**. Note the count is 30, not 29:
  `harness_http.md` lists the additions in seven table rows because `plugin_enabled` and
  `plugin_disabled` share one. Eight names, seven rows.
- **`context_usage` is ephemeral** — null `id`/`seq`, broadcast never persisted, matching
  `ai_text_delta`. Registered in `Event::EPHEMERAL_TYPES` on the Rails side, without which
  ingest would persist it and hand it a durable `id`. The durable per-run figure lives on
  `run_finished`/`run_failed` as it already did.
- **`recovery_applied` is what makes /AC4 observable.** After a crash the feed states
  that a request's fate is *unknown* rather than implying either outcome — `uncertain:
  true` is a first-class value, not an error.
- **`plugin_enabled`/`plugin_disabled` are session-scoped** (null `ai_run_id`/`seq`) —
  enabling a plugin is a property of the room, not of whatever run happens to be open.

### Also corrected in this entry (pre-existing drift, no behaviour change)

Three artifacts still claimed a **20**-name taxonomy after v1.2 and v1.3 had already
taken it to 22, each with a guard that had drifted alongside the thing it guarded:

- `packages/contracts/src/events.ts` — the `EventPayloadMap` comment said "the 20 names".
- `docs/contracts/events.md` — the envelope example and field table said "one of the 20
  names" while §2 of the same document said "exactly 22".
- `api/app/models/event.rb` — `Event::TAXONOMY` listed 20 entries, missing `user_prompt`
  and `ai_thinking_delta`, and `event_spec.rb` asserted `size == 20`, so the constant and
  its guard were wrong together and CI was green.

Additionally, `packages/contracts/tsconfig.json` included only `src/**/*.ts`, so the
exhaustive `Record<EnvelopeType, …>` in `fixtures/sample_run.test.ts` — the guard that
should have caught the missing names — **was never type-checked**. The include now covers
the fixture test, which is what gives that guard teeth.

### Unchanged (why this is a `minor`, not a `major`)

The envelope fields + scalar types, the `Actor` union, all 22 existing names and their
payloads, the `(ai_run_id, seq)` idempotency + dual-cursor rules, and the
ephemeral-vs-durable rule are **unchanged**. A consumer requiring exact `major` and
`minor ≥ 4` stays compatible.

## [review-approve-roles] — approve/reject extended to editor + reviewer

**`CONTRACT_VERSION` unchanged** — this changes the 4-role matrix (an authorization
rule in `http_api.md §4`), not the event contract in `events.ts` (no envelope, type,
payload, or endpoint-signature change). Change: `review-approve-roles-and-layout`.

### Changed (authorization matrix)

- **`approve / reject changeset`** is now permitted for **owner, editor, and reviewer**
  (previously owner-only); **viewer** still cannot. Server-enforced in
  `SessionPolicy::MATRIX`; the client mirror + button-gating and the landing roles
  table follow. Driving Claude (run/follow-up/interrupt) stays owner+editor, and
  invites/archive/bypass stay owner-only. Updated `http_api.md`,
  `openspec/specs/http-api-contract`, and `openspec/specs/diff-review-approve`.

## [run-tools-connectors-skills] — per-run tool/connector/skill selection (additive)

**`CONTRACT_VERSION` bumps `{ major: 1, minor: 3 }` → `{ major: 1, minor: 4 }`** — additive
optional payload fields + new additive endpoints/body fields; no event type, envelope, or
**existing** endpoint signature changes. Change: `run-tools-connectors-skills`.

### Added (additive — nothing removed or renamed)

- **`RunStartedPayload`** gains optional `disallowed_tools?` / `connectors?` / `skills?`
  (`events.ts`), echoing the **resolved** capabilities a run applied.
- **Shared types + constant** in `events.ts`: `ToolInfo`, `ConnectorInfo`, `SkillInfo`, and the
  canonical `BUILTIN_TOOLS` / `BUILTIN_TOOL_IDS` (the 8 built-ins; there is no `/api/tools`
  endpoint — tools never vary by host/repo).
- **`POST /runs`** (`harness_protocol.md` §5) gains optional `disallowed_tools` (→ SDK
  `disallowedTools`, the only true disable), `connectors` (host MCP server names → `mcpServers` +
  `mcp__<name>__*`), and `skills` (`"all"` | names → `settingSources` + `skills`).
- **Harness discovery** `GET /connectors?cwd=` · `GET /skills?cwd=` (read-only, name+transport
  only, degrade to empty+unavailable).
- **Client REST** `GET /api/sessions/:id/connectors` · `GET /api/sessions/:id/skills`
  (`http_api.md`) — session-scoped proxy (participant-gated, `404` cross-session, `502` harness
  down); run start accepts the additive body fields (`422` unknown; existing `:run` `403` gate).

Omitting every field reproduces today's behavior, so the change is backward-compatible at every hop.

## [http-api] — session history + owner archive (http-api-contract, additive)

**`CONTRACT_VERSION` unchanged at `{ major: 1, minor: 3 }`** — this adds two REST endpoints
(`http_api.md`); no event type, envelope, payload, or **existing** endpoint signature changes, so
the event contract version does not move. Change: `session-history-and-archive`.

### Added (additive — nothing removed or renamed)

- **New endpoint `GET /api/sessions`** — a per-user index of the caller's sessions (host or
  participant), `200` with an ordered array of
  `{ id, title, mode, status, my_role, last_activity_at, created_at }`, newest activity first.
  Gated only by a valid `clawd_uid`; unauthenticated is `404` (the shared `require_user`
  anti-enumeration posture). Adding an endpoint is additive; no existing signature changed.
- **New endpoint `POST /api/sessions/:id/archive`** — owner-only hard close (`active → archived`,
  terminal), `200 { id, status: "archived" }`, idempotent. New role-matrix row **archive session**
  (owner-only). Starting a run on an archived session is now refused (`409`) — a new refusal on the
  **existing** `POST /api/sessions/:id/runs`, not a signature change.

### Unchanged (why this is not a `major`)

The event envelope, the 22-name taxonomy, all payloads, the `(ai_run_id, seq)` rules, and every
**existing** endpoint request/response signature are untouched. The data model gains a
`sessions.last_activity_at` column, which is internal (not part of any wire contract).

## [protocol] — selectable Claude permission mode (harness-protocol, additive)

**`CONTRACT_VERSION` unchanged at `{ major: 1, minor: 3 }`** — this touches the **harness protocol**
(`harness_protocol.md`), not the event taxonomy/envelope/payloads, so the event contract version does
not move. Change: `claude-permission-modes`.

### Added / widened (additive — nothing removed or renamed)

- **`permission_mode` on `POST /runs`** is now a **selectable allowlist** value — `plan` / `acceptEdits`
  (the default when omitted, i.e. the prior fixed behavior) / `bypassPermissions` — rather than the fixed
  literal `acceptEdits`. Omitting the field is unchanged behavior, so existing callers are unaffected.
  `bypassPermissions` is **owner-only** (Rails-enforced) because the SDK does not constrain it by
  `allowed_tools`. Values outside the allowlist are rejected by Rails (`422`).
- **New endpoint `POST /runs/:id/permission_mode`** (`{ permission_mode, requested_by }` → `200
  { run_id, permission_mode }`; `404` unknown; `409` not active) — switches the active run's mode
  in-session (plan→execute). Adding an endpoint is additive; no existing endpoint signature changed.

### Unchanged (why this is not a `major`)

The event envelope, the 22-name taxonomy, all payloads (`run_started` already carried `permission_mode`),
the `(ai_run_id, seq)` rules, and every **existing** endpoint signature are untouched. `cwd` stays pinned
to the worktree in all modes; `canUseTool` stays allow-all (per-tool live approval remains out of scope).

## [1.3.0] — `ai_thinking_delta` event, live streaming (additive)

**`CONTRACT_VERSION = { major: 1, minor: 3 }`.** Additive `minor` bump (`live-streaming-thinking`): a new
**ephemeral** event type so Claude's thinking can stream live, matching how `ai_text_delta` already streams
text. Live streaming was designed but unwired (the runner never enabled partial messages); this finishes it.

### Added (additive — nothing removed or changed)

- **`ai_thinking_delta` event type** (the 22nd taxonomy name) — **ephemeral** (broadcast, never persisted;
  null `id`/`seq`), payload `AiThinkingDeltaPayload { block, text }` mirroring `ai_text_delta`. Keyed by the
  same `"<uuid>:<index>"` block key as the durable `ai_thinking`, so the live accumulator reconciles with the
  settled block. Registered ephemeral in the harness normalizer and Rails `Event` (alongside `ai_text_delta`
  and `presence_changed`).
- **`EVENT_TYPE_COUNT`** freeze guard updated `21 → 22`.
- **Harness streaming** (behavior, not contract): the runner enables `includePartialMessages` + adaptive
  thinking and maps `content_block_delta` `text_delta` → `ai_text_delta` and `thinking_delta` →
  `ai_thinking_delta` (see `provider_event_mapping.md`).

### Unchanged (why this is a `minor`, not a `major`)

The envelope fields + scalar types, the `Actor` union, `ai_text_delta` and every other type, the
`(ai_run_id, seq)` idempotency + dual-cursor rules, and every endpoint/protocol signature are **unchanged**.
`ai_thinking_delta` is ephemeral like `ai_text_delta` (null `id`/`seq`, broadcast-not-persisted) so it needs
no persistence changes. A consumer requiring exact `major` and `minor ≥ 1` stays compatible.

## [1.2.0] — `user_prompt` event (additive)

**`CONTRACT_VERSION = { major: 1, minor: 2 }`.** Additive `minor` bump (`user-prompt-event`): a new
event type so the activity feed can show the human's words, not just Claude's. The feed is rebuilt
from the event stream alone; the prompt previously lived only on `AiRun.prompt` and was never an
event, so a watcher saw answers to invisible questions.

### Added (additive — nothing removed or changed)

- **`user_prompt` event type** (the 21st taxonomy name) — **run-scoped, durable**, `actor.kind: "user"`
  (the requesting participant), payload `UserPromptPayload { text }`. Carries the initial prompt and
  each mid-run follow-up.
- **Producer:** the **harness** emits it (it already holds the prompt text and **owns the per-run
  `seq` space** — Rails has no collision-free run `seq`). Emitted immediately **before** each user
  message is pushed into the SDK streaming-input iterable, so the prompt's `seq` precedes the output
  it triggers (on a fresh run: `user_prompt` = `seq 1`, `run_started` = `seq 2`).
- **`EVENT_TYPE_COUNT`** freeze guard updated `20 → 21`.

### Unchanged (why this is a `minor`, not a `major`)

The envelope fields + scalar types, the `Actor` union, the `(ai_run_id, seq)` idempotency + dual-cursor
rules, the ephemeral-vs-durable rule, and every endpoint signature are **unchanged**. `user_prompt`
rides the existing harness→Rails ingest path and the `[ai_run_id, seq]` index like any other run-scoped
durable event; Rails needs no new code (ingest persists it verbatim, `Runs::Finalize` ignores it). A
consumer requiring exact `major` and `minor ≥ 1` stays compatible (proven across `1.0 → 1.1`).

## [1.1.0] — SDK payload finalization (additive)

**`CONTRACT_VERSION = { major: 1, minor: 1 }`.** Additive `minor` bump (`sdk-message-spike`):
per-type `payload` schemas, previously `pending-spike`, are now finalized from real
`@anthropic-ai/claude-agent-sdk` `query()` output captured over Bedrock.

### Added (additive — nothing removed or changed)

- **Concrete per-type payload interfaces** in `packages/contracts/src/events.ts` (`EventPayloadMap`
  + one interface per type), replacing the `unknown` `PendingSpikePayload` stubs.
- **`docs/contracts/provider_event_mapping.md`** — the single source mapping each raw SDK message shape →
  Contract-1 type + payload, derived from `harness/test/fixtures/raw_run.jsonl`.
- **Resolved `ai_text_delta` `block` field** — `"<assistant_message_uuid>:<content_block_index>"`.
- **Pinned PLAN payload obligations** — `total_cost_usd` + `usage` on `run_finished`/`run_failed`;
  `tool_started.input_summary` (≤~500 chars, never the full Edit/Write content); `terminal_output`
  ~64KB chunks.
- **Real `packages/contracts/fixtures/sample_run.jsonl`** — spike-derived envelopes with concrete
  payloads, replacing the v1.0 envelope-only placeholder. The frozen structural invariants are
  unchanged (the existing fixture test still passes; a non-empty-payload smoke check is added).

### Unchanged (why this is a `minor`, not a `major`)

The envelope fields + scalar types, the 20 type names + `ai_raw`, the per-type actor/durability/scope
axes, the `(ai_run_id, seq)` idempotency + dual-cursor rules, the ephemeral-vs-durable rule, the
`actor` union, and every endpoint signature are **unchanged**. A consumer requiring an exact `major`
and `minor ≥ 0` (e.g. the Rails `ContractVersion`/`FakeClaude::Replay` consumer) stays compatible.

## [1.0.0] — Week 1 freeze

**`CONTRACT_VERSION = { major: 1, minor: 0 }`.** Frozen at the Wednesday-of-Week-1 gate
(`docs/PLAN.md §11`); per-type payloads deferred as `pending-spike` (finalized additively at 1.1).

### Frozen now

- **Event envelope** — `{ id, session_id, ai_run_id, seq, type, actor, ts, payload }` with pinned
  scalar types; `ts` is ISO-8601 UTC ms+`Z`, display-only.
- **Taxonomy** — exactly 20 type names + the `ai_raw` fallback; asserted at 20 in `events.ts`.
- **Per-type axes** — `actor.kind`, durable-vs-ephemeral, and run-vs-session scope for every type
  (the per-type table in `events.md §6`).
- **Cursors & idempotency** — per-run monotonic `seq`, global `id`; idempotent ingest on
  `(ai_run_id, seq)`; client dedupe-by-`id` for durable events.
- **Ephemeral rule** — `ai_text_delta` / `presence_changed` are broadcast-but-never-persisted,
  carry a null `id`, and never consume `seq`.
- **`actor`** — discriminated union `{ kind: "claude" } | { kind: "user"; id } | { kind: "system" }`.
- **Harness protocol** — all six endpoint signatures + success/error shapes; the worktree
  convention + `base_sha` rule; compose-network addressing (`HARNESS_URL` /
  `RAILS_INTERNAL_URL`); bearer `HARNESS_SHARED_SECRET` auth with constant-time compare.
- **HTTP + cable API** — REST surface; `/~cable` mount + one-envelope rule; the 4-role matrix;
  `403`-vs-`404` anti-enumeration rule; `clawd_uid` cookie auth; gap-free catch-up.
- **`packages/contracts`** — `events.ts` (envelope, taxonomy, `Actor`, `CONTRACT_VERSION`,
  compile-time freeze guards) + `fixtures/sample_run.jsonl` (the executable contract).

### Spike-gated (deferred — `pending-spike`)

- Per-type `payload` field schemas in `events.md` and concrete payload interfaces in `events.ts`
  (currently `unknown` stubs).
- The `ai_text_delta` `block` field representation.
- Real spike-derived `fixtures/sample_run.jsonl`. **Interim:** a hand-authored, envelope-only
  placeholder (`{}` payloads) stands in to unblock ingest plumbing — see
  `packages/contracts/fixtures/README.md`. Replacing it with real spike output will be an
  **additive** `minor` bump.
