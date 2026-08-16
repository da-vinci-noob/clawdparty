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
| Change a frozen **endpoint signature** (path, method, request/response shape, status) | **breaking** | a **breaking** entry; emergency; **no `CONTRACT_VERSION` bump** — see the resolved governance question below | — |
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
- **Projection repair, client-facing (owner-only)** — `GET /api/sessions/:id/projection/check`
  and `POST /api/sessions/:id/projection/rederive`, documented in
  [`http_api.md §2`](./http_api.md). Additive: no existing endpoint changes shape, and a
  client that never calls them is unaffected. They exist because `events` became a
  *projection* in this window — the repair is the other half of that change, and without it
  /'s "a gap is repairable, not lost" has no way to be exercised.
  `POST` defaults to **gap-fill**; `reset: true` must be asked for, and does not broadcast.
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

### Breaking — harness store schema again (B9)

| # | Change | Streams |
|---|---|---|
| B9 | **`STORE_SCHEMA_VERSION` 2 → 3.** `entries` gains `emitted INTEGER NOT NULL DEFAULT 1` plus two CHECK constraints pairing it to `seq`, so a store-only entry is MARKED rather than inferred from two nullable fields. An existing store is REFUSED at open with `incompatible_version`. | harness |

**This entry was missing and is being added late.** The bump shipped in its commit
without one, which the governance table above requires for a store-schema change — and the
omission had a consequence: nothing warned that existing sessions would stop working, so the
first sign of it was a `500` on run start.

**B7 was accepted on a basis that has since expired.** It reads "acceptable inside the window
on the stated basis that this is a fresh setup with no sessions to preserve." That is no
longer true — a developer hit this with a live session (8 entries, schema_version 1). Any
further store-schema change inside this window must state the recovery step in its own entry,
not inherit B7's premise.

**Recovery, because refusal without a recovery path is a dead session.** The store is the
record and it cannot be migrated (that is the point of invariant 11 — misreading an older
layout is how a record silently lies). So the only recovery is to discard the refused store
and let the session start a new one:

```bash
bin/harness reset-session <id>     # moves the store aside, then reports what was discarded
```

It MOVES rather than deletes, so the old file is still there to inspect. What is lost is that
session's harness-side record; Postgres `events` keeps the projection, so the feed's history
survives — the session simply cannot resume its model conversation.

### Breaking — the fixture is recaptured, not edited (B8)

| # | Change | Streams |
|---|---|---|
| B8 | **`fixtures/sample_run.jsonl` is regenerated from a real harness run** (`npm run capture:fixture`). `RunStartedPayload` drops `permission_mode` and `claude_session_id`. `file_changed` now follows the OUTCOME, so a failed write emits none at all. `recovery_applied` carries a `seq` — it is durable per `events.md` and was being emitted with `seq: null`. `CONTRACT_VERSION` unchanged: the taxonomy is untouched and `RunStartedPayload` loses two fields no producer has filled since the engine swap. | harness, api, web |

The fixture was captured from an Agent SDK spike, and that SDK is deleted — so it had
drifted into describing a predecessor system on four counts, all verified before deciding:
`run_started` still carried the two Agent-SDK fields; `recovery_applied.from_phase` said
`awaiting_provider_response` where the harness emits `request_pending`; `file_changed`
preceded `tool_failed` because it was derived from the tool CALL; and it contained no
`ai_raw` at all, so it never described the tool-result surface write either.

**It is now generated, not hand-maintained.** A hand-edited fixture drifts again; a
generated one drifts only when behaviour does, and the diff is the review artifact.
Regeneration is byte-identical (fixed clock, fixed ids, normalized scratch path) so the
diff is readable.

Two things the recapture could NOT do, stated rather than hidden:

- **Five types have no emitter** — `chat_message` and `participant_joined` are
  Rails-originated, and `context_compacted`/`context_usage`/`provider_error`/`plugin_*`
  belong to unbuilt stories. They live in `fixtures/not_yet_emitted.jsonl` and are appended
  verbatim. Deleting them to make the file "purely captured" would silently drop coverage
  for types the taxonomy already froze.
- **The parity comparison is now circular** — it checks the harness against its own output.
  That is accepted, and mitigated two ways: the narrative is a SHARED module
  (`scripts/narrative.ts`) so the capture and the test cannot diverge into an empty
  comparison, and `behaviour_parity.test.ts` asserts properties the fixture cannot vouch for
  (every `tool_use` answered, ephemeral events carrying null `seq`/`id`, gapless durable
  `seq`, tool results in ONE user message). Golden-file testing proves stability, not
  correctness; the properties cover the rest.

### Governance question — RESOLVED

The table at the top of this file said a frozen **endpoint signature** change bumps
`CONTRACT_VERSION.major`. Two earlier entries did the opposite, holding it still on the
grounds that it versions the *event* contract. B1–B7 followed that precedent, which left
 ("...with a version bump") measurably unmet across seven breaking changes.

**Resolved in favour of the precedent, and  amended to say so.** `CONTRACT_VERSION`
is what a consumer asserts against to decide whether it can read an event stream. Bumping
`major` for an endpoint, topology or store-schema break would fail that assertion for
every consumer, for a reason that does not apply to any of them — while telling them
nothing about the break that actually happened. The event contract has
`CONTRACT_VERSION`; the store has `STORE_SCHEMA_VERSION`; endpoints and topology are
versioned by this file and the declared window.

The governance table above is corrected accordingly. What has NOT changed: every break
still needs an entry here and still must fall inside the window. The looser rule is about
which number moves, not about whether the change is recorded.

## [ephemeral-ordering] — delivery order and settled-block terminality (clarifying)

**No version bump: no type, field, or endpoint changed.** This records two obligations that were
always implied by "ephemeral events carry no cursor" and were being violated by all three
streams, so they are now stated in [`events.md §6`](./events.md) rather than left to inference.

1. **The producer delivers ephemerals single-file.** They have no `seq` and no `id`, so a
   consumer concatenates them in ARRIVAL order — order therefore has to be a property of
   delivery. The harness sent one unawaited POST per delta, and under ordinary latency variance
   a sentence arrived with its words permuted ("The so add a contributions section" as "a
   section so contributions add The"). It now coalesces into ~150ms batches per
   `(type, session_id, ai_run_id, block)` and keeps one request in flight. Only the accumulating
   types may be merged; `presence_changed` and `context_usage` are whole values.

2. **Settling a block is terminal for its deltas.** Ephemeral and durable events travel over two
   independent channels, so `ai_text` routinely lands before the tail of its own delta stream
   (observed in production). A consumer that re-creates the live accumulator on a late delta
   renders the block twice — once settled, once as a fragment. Consumers must DROP deltas for a
   settled block, not merely clear the accumulator when it settles.

Also fixed alongside, in the harness rather than the contract: deltas were accumulated and
emitted at the TURN BOUNDARY, so `ai_text_delta` carried no earlier information than the
`ai_text` beside it and 's two-tier streaming delivered nothing incremental. Deltas now
leave as they are produced. Neither of these was detectable by reading the contract — both were
found by generating a real run and reading what arrived.

## [endpoint] — `POST /api/providers/verify` and harness `POST /verify` (additive)

**No `CONTRACT_VERSION` bump** — per the governance table, endpoint changes are recorded here and do
not move the event contract's version. Two new routes, both additive: nothing that existed changed.

**Why.** `GET /api/models` answers "was a credential found", and the settings surface
needs "would a run be accepted". They are different claims, and the gap is measured, not theoretical:
`us.amazon.nova-premier-v1:0` refuses an entitled-looking credential, and the `linear` MCP server
answered `invalid_token` while being correctly configured. An auth test built on `probe()` would
report both as healthy.

So the harness gains `POST /verify`, which sends **one 1-token real request per provider** through
the adapter's own `stream()` — the same path a run takes, so a pass means a run would be accepted —
and Rails proxies it at `POST /api/providers/verify`.

**A POST, deliberately.** It is not a read: it spends tokens and touches the provider. It is also
**not cached**, because the reason anyone opens it is that something just changed.

**Withheld by construction:** `credentialSource` is a name (`env:AWS_PROFILE`), never a value
; `error` is the provider's own message, which is the diagnostic; `usage` states the cost.
Readable by any participant, like `/api/models` — the route is not session-nested, and a viewer who
cannot diagnose a provider failure has to ask someone else to look.

## [1.9.0] — the harness is an MCP client; `run_started` reports failed connectors (additive)

**`CONTRACT_VERSION = { major: 1, minor: 9 }`.** Additive `minor` bump: one new OPTIONAL field on
`RunStartedPayload`.

```ts
connectors_failed?: Array<{ name: string; kind: "not_configured" | "timeout" | "failed" }>;
```

**Why.** `connectors` was accepted, validated by Rails, forwarded to the harness, and dropped —
`capabilities.ts` still held a resolver that turned selected names into SDK `mcpServers` and nothing
called it — while the composer sent every discovered connector on every run and the popover showed
the host's live server count. The room advertised capabilities no run had. The harness
now IS the MCP client: it connects (stdio / streamable HTTP / SSE), calls `tools/list`, and registers
each tool as `mcp__<server>__<tool>` in that run's own registry, so MCP tools go through the same
`tool:before` gate, the same `tool_started`/`tool_finished` events, and the same `disallowed_tools`
filter as the built-ins.

Once connectors are real, failing to load one has to be **sayable**. `connectors` already carried the
resolved list, so absence alone was the only signal — indistinguishable from "the server returned no
tools". `connectors_failed` names the server and classifies why, and the run continues: a broken
server is not a broken run.

**`kind` is a classification, never the transport's error text.** A message from a server we do not
control could carry a URL with a token in it, and the connector listing already withholds every
server's command/url/headers for that reason. The raw message goes to the harness's stderr, which is
host-side and outside the record. Verified live: `linear` on this host fails with
`invalid_token`, the event records `{name: "linear", kind: "failed"}`, and the string `invalid_token`
appears nowhere in the payload.

**What consumers should do.** Render it — the participant who enabled a connector needs to know it
did not load, and `run_started` is the only place a late joiner arriving by backfill can learn it.
The three kinds map to three different remedies (configure it / retry / fix the server).

**A behaviour change that is not a contract change, and matters more than the field.** Connectors are
now **opt-in per run**, default OFF, with a toggle per server in the capabilities panel. Auto-enabling
them was free while the harness ignored them; measured against this host's 8 servers it is not —
**77 tools and ~150KB of schema, about 37,500 tokens, on every turn**, plus ~5s of connect time. One
server (`drawio`) is 2 tools and 60KB by itself, so the cost does not track the tool count.

**Recovery / migration.** Nothing stored changes. Runs recorded before this bump listed connectors in
`run_started` that were never actually loaded; that is a historical claim the projection cannot
repair, and the field's meaning is unchanged going forward (it lists what loaded).

## [1.8.0] — `toolUse` is a boolean, and `BUILTIN_TOOLS` ids are the harness's real tool names

**`CONTRACT_VERSION = { major: 1, minor: 8 }`.** Two changes, both from the same finding, and the second is a
**breaking value change inside the open migration window** rather than an additive one.

```ts
interface ProviderCapabilities {
  streaming: true;
  toolUse: boolean;   // was: literal `true`
  ...
}
```

**Why `toolUse` widens.** Same shape problem `toolUseWhileStreaming` fixed at v1.6, one level up:
the literal asserted that every model uses tools. `us.deepseek.r1-v1:0` on Bedrock answers
`ValidationException: This model doesn't support tool use` in BOTH transports, so unlike the
streaming case there is no fallback an adapter could pick. A capability the contract cannot state
becomes an exclusion in code, which is how R1 ended up simply absent from the picker with nothing
to explain why. Widening it is additive for consumers (a `boolean` reads where `true` did) and for
producers (every adapter already passes `true`), so nothing broke — which also means **no compile
error forced adapters to reconsider**, unlike the v1.6 field addition. `assertTotalCapabilities`
now requires an explicit boolean and rejects the nonsense combination
`toolUse: false, toolUseWhileStreaming: true`.

A `false` model runs **answer-only**: the run carries no tool declarations, the picker labels it
"no tools (answers only)", and the run banner says so from the run's own `run_started` payload so a
late joiner learns it too. A run that DOES offer such a model tools is refused with the reason —
dropping them quietly would leave a model that narrates edits it never made.

**Why the tool ids change (breaking).**

| before | after |
|---|---|
| `Read` `Write` `Edit` `Bash` `Glob` `Grep` `WebSearch` `WebFetch` | `read` `str_replace_based_edit_tool` `bash` `glob` `grep` `web_search` `web_fetch` |

Those were the **Agent SDK's** names, and nothing has answered to them since the SDK was removed:
the harness registers provider-native tools and `ToolRegistry.schemasFor` filters `disallowed_tools`
by EXACT name. So the per-run tool disable did **nothing** — measured, not inferred: disallowing all
eight advertised ids left every registered tool declared. Both suites were green throughout, because
the web asserted the request body it sent and the harness asserted the filter it applied, and no
test compared the two vocabularies — the same both-sides-green shape as earlier defects.

`Write` and `Edit` collapse into one entry: there is ONE editor tool that both creates and edits, so
two ids for it could never be honoured separately. `label` is what the UI renders — `id` is a
registry name, and one of them is `str_replace_based_edit_tool`.

**What consumers must do.** Send tool ids from `BUILTIN_TOOL_IDS`, never a hardcoded string. Rails'
`Runs::Start::DEFAULT_ALLOWED_TOOLS` is the Ruby copy and matches.
`harness/test/tools/builtin_vocabulary.test.ts` asserts the list against the live registry in BOTH
directions, so a tool added to one side and not the other now fails the build.

**Recovery / migration.** Nothing stored changes. A run recorded before this bump has
`disallowed_tools` in the old vocabulary in its `run_started` payload; it had no effect then and it
has none now, so no re-derivation is possible or needed. Note that `allowed_tools` is still ACCEPTED
and still unused by the harness — a genuine SDK leftover, filed separately rather than quietly
dropped here.

## [1.7.0] — `total_cost_usd` is nullable (additive)

**`CONTRACT_VERSION = { major: 1, minor: 7 }`.** Additive `minor` bump: `total_cost_usd` on
`run_finished` and `run_failed` widens from `number` to `number | null`. Consumers that treated it
as a number keep compiling; one that DISPLAYS it must now handle null.

**Why.** The harness sent a hardcoded `0`. That was inert while nothing read it, and became a
false statement the moment Rails began copying the figure onto `ai_runs.total_cost_usd`:
every run would have recorded a cost of exactly zero. No provider in play reports a price —
Bedrock does not, and the harness computes none — so `0` claims a request that was actually made
was free. `null` says "unknown", which is the truth.

This is the rule the usage ledger already followed, applied to the one field that was breaking it:
*no report means unknown, and the honest record of unknown is no row at all* (`usageWrites` writes
no ledger row when a turn reported nothing, rather than a row of zeros).

**What consumers should do.** Render an unknown cost as unknown — a dash, not `$0.00`. Rails
stores `nil`, and both `ai_runs.usage` and `ai_runs.total_cost_usd` are nullable for exactly this
reason: `nil` and `0` are different claims.

**Recovery / migration.** No stored data changes and no re-derivation. Runs recorded before this
bump have `total_cost_usd` nil (Rails never wrote the column at all until it began copying it), so nothing holds
a wrongly-zero cost. Real per-model pricing is a separate piece of work — Bedrock exposes no price
API, so it needs a maintained table.

## [1.6.0] — `toolUseWhileStreaming` capability (additive)

**`CONTRACT_VERSION = { major: 1, minor: 6 }`.** Additive `minor` bump: one new REQUIRED field
on `ProviderCapabilities`. Additive for consumers (Rails and the web gain a field they may
ignore); for producers it is a compile error until every adapter declares it, which is the
intent — the value must be stated, never inferred.

```ts
interface ProviderCapabilities {
  streaming: true;
  toolUse: true;
  toolUseWhileStreaming: boolean;  // NEW
  ...
}
```

**Why.** `streaming` and `toolUse` are LITERAL `true` types, so the contract asserted that every
provider does both, unconditionally, and could not express otherwise. On Amazon Bedrock they are
independent: measured against 18 distinct text-capable non-Anthropic inference profiles in
us-west-2, **8 refuse a `toolConfig` on `ConverseStream`** with `ValidationException: This model
doesn't support tool use in streaming mode`, while accepting the same request on non-streaming
`Converse` — every Meta Llama, Mistral Pixtral, and both Writer Palmyra models, two of which
return a real `tool_use` stop reason there. It is a transport limit, not a model limitation, and
the two literals stay TRUE when the new field is false: the model streams, and it uses tools,
just not in one turn.

**What consumers should do with it.** Read it as the answer to "will live text arrive on a run
that has tools enabled". `false` means the host must pick another model, run without tools, or
accept a turn that only appears once it settles. The web picker labels such models
(`prompt_composer.tsx`); the loop REFUSES a tools-enabled turn on one and emits a
`provider_error` naming the constraint and its remedy, rather than sending a request the provider
would reject or quietly dropping the tools.

**Recovery / migration.** No stored data changes and no event payload changes, so no session is
affected and nothing needs re-derivation. A provider adapter written before this bump will not
compile until it declares the field; Anthropic adapters declare `true`, which is measured
behaviour, not an assumption.

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
