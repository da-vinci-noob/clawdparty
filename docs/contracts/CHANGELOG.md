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

## ✅ MIGRATION WINDOW — CLOSED (harness architecture)

**Opened: 2026-08-16.** **Closed: 2026-08-17.** **Must close by: 2026-09-15** — closed 29 days early.
**Signed off: 2026-08-16.** Status: **CLOSED — breaking changes are now defects .**
Change: `001-harness-harness-architecture`.

### What actually shipped inside it

All six declared breaking changes shipped, each verified in the tree rather than assumed:

| # | Declared | Shipped as |
|---|---|---|
| B1 | `POST /runs` gains `lane`/`provider`/`effort`, drops `claude_session_id` | Done. `claude_session_id` survives only in comments recording its removal; resumption is harness session + lane, carried by `resume_context`. |
| B2 | `POST /runs/:id/permission_mode` REMOVED | Done. Route absent (asserted as a 404 in `server.test.ts`, because a removal nothing tests comes back); replaced by the `tool:before` extension point plus the per-run tool set. |
| B3 | `GET /models` → `{ providers: [...] }` | Done. Never 500s; an unavailable provider is reported with a reason, and since [discovery-classification] that reason distinguishes an expired credential from a network fault. |
| B4 | Heartbeat gains `store_seq_high_water` | Done. |
| B5 | One-active-run per SESSION lifted → per LANE | Done, latest of the six. `index_ai_runs_one_active_per_lane` on `(session_id, lane)` replaces the per-session index; verified against the live database, not only as a migration. |
| B6 | The harness is no longer a container; every route bearer-authed | Done. No `harness` service in `docker-compose.yml`, the process refuses to start in a container , and `inbound_auth.test.ts` derives its route list from Fastify's own routing table so a new route cannot skip auth. |

**Three additive changes rode the window** and are recorded in their own entries below: the event
taxonomy grew 22 → 32 types, `CONTRACT_VERSION` went `{1,4}` → `{1,14}`, and the endpoint surface
gained verify/skills/plugins/aws-profiles routes plus projection repair.

**Two breaking changes were CONSIDERED and rejected**, which is worth recording because the window was
the only chance to make them: rewriting  to permit third-party plugin loading (measurement showed
that `env: {}` contains only the environment, so the claim could not be honoured — bundled-only
instead), and hard-deleting a participant on removal (`events.actor_participant_id` has a foreign key,
so the database refuses to orphan history — `removed_at` instead).

**What closing means from now on.** Additive is cheap and needs a `minor` bump plus an entry here.
Anything that breaks the envelope, removes a type, or changes a frozen endpoint signature is a
**defect**, not an amendment (Principle I) — it needs a fix, not a version bump. A future window would
need its own sign-off and its own declared list.

This was the first and intended-only declared window in the project's life. Per ,
breaking interface changes were permitted **only** inside it; outside it, changes are
additive or they are defects. Per  the rename rode in the same window as the
protocol breaks, so the coordination cost was paid once instead of twice.

**The close date was a deadline, not a forecast** — 30 days chosen to make the window falsifiable,
because a window that cannot be breached is not a window. It closed on day 2, with all six declared
breaks shipped. The list above is what the close-out audit was written to produce.

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

- **`~/.claude` and `~/.aws` bind mounts are gone.**
  **Correction: "the Keychain is now readable directly" was FALSE when written.** The
  `keychain:anthropic-oauth` slot existed, but its probe was injected and defaulted to FALSE, so it
  was unreachable in production — and the service name it would have queried (`"Claude Code"`) does
  not exist on a real host. Both are fixed: `credentials/keychain.ts` runs
  `security find-generic-password -s "Claude Code-credentials"` (the measured name) in fixed argv
  form, and `keychainHasToken()` now returns true on a host that has the credential — verified.
  It checks EXISTENCE only and never passes `-w`, so the secret never enters the process; the SDK
  resolves the credential itself, exactly as on the file path. `CLAUDE_CODE_OAUTH_TOKEN` remains
  supported and still wins its precedence slot, so a developer who set it deliberately is not
  overridden. `aws sso login` freshness is unchanged — nothing can refresh that token on the
  developer's behalf.
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

## [projection-store-seq] — `store_seq` is per EVENT, and a reset keeps what it cannot rebuild (clarifying)

No version bump: the wire shape is unchanged and `store_seq` always meant "this event's position in
the record". The harness was sending something else, Rails was dropping it, and the repair was
deleting rows nothing could put back. Found by running the acceptance walkthrough's S4.3 against the
live stack for the first time — the / mechanism had never been able to pass.

**1. Rails dropped the field.** `Internal::EventsController#permit_event` did not permit
`:store_seq`, so strong params silently discarded it and every row landed with NULL.
`Events::ProjectionCheck` matches on it, so the audit compared nothing to nothing and reported
`diverged: false`. Any consumer that trusted a green check on data written before this got an
answer with no evidence behind it.

**2. The harness sent one value per BATCH.** `Supervisor.ship()` stamped `store.maxStoreSeq()` on
every durable event, read after the commit — so a two-event batch shipped the same number twice, and
the number ran ahead of the entries by however many non-entry rows the commit also wrote (the
position marker is itself a row, so the drift grew). `HarnessStoreApi` gains
**`storeSeqFor(runId, seq)`**, backed by the `UNIQUE (run_id, seq)` index that already makes ingest
idempotent; `ship()` looks up each event's own position and falls back to the high-water mark only
for an event with no entry behind it.

**3. `rederive(reset: true)` destroyed the chat and the review audit trail.** It deleted every row
for the session and replayed the harness log, but Rails appends `chat_message`,
`changeset_approved`/`rejected` and `participant_joined` itself and the record holds none of them —
so the one operation an operator runs to REPAIR a session lost them permanently. The delete is now
scoped to `store_seq NOT NULL`. Preserved rows keep their old, lower `id`s, so after a reset a
mid-session chat message sorts before the transcript in an `id`-ordered feed; `ts` stays correct and
a reset already forces a client reload. Documented in `http_api.md`.

## [1.15.0] — an interrupted run reports what it spent, and an interrupt is not a failure (additive)

**`CONTRACT_VERSION` 1.14 → 1.15.** `RunInterruptedPayload` was `Record<string, never>` and now
carries two OPTIONAL fields, `usage` and `total_cost_usd`, matching `run_finished`/`run_failed`.
Additive: a consumer that ignores them is unaffected, and both follow the v1.7 rule — absent means
UNKNOWN, never zero, for a request that was actually made.

Two defects, both found by driving S9 on the live stack.

**1. A mid-stream interrupt was recorded as a FAILURE.** A real Bedrock run in the `side` lane was
interrupted while streaming; the harness accepted the interrupt with a 200 and the run terminated as
`run_failed` with `stop_reason: "api_error"`, `explanation: null`, `api_error_status: null`. Someone
who pressed Stop was told their run hit an API error, and given a remedy — "check network access to
the provider" — for something they did on purpose.

The cause is where the loop LOOKS: `spec.signal.aborted` was checked at the top of the turn loop,
which is a turn BOUNDARY. An abort arriving mid-turn is visible only to the transport, which throws,
and `classifyStreamError` knows about 401/403/429 and nothing about aborts. The signal is now
checked at the catch as well. Deliberately the SIGNAL and not the error's wording: every transport
words an abort differently, and the run's own signal is ground truth about what was asked for.

Interrupt is one of the five capabilities this product never cuts, and the suite was green:
`independent_interrupt.test.ts` asserts which lanes stay ACTIVE after an interrupt and never looks
at the event that resulted.

**2. `RunLoop.interrupt()` took the accumulated usage as `_usage` and discarded it.** Exactly the
shape `RunFailedPayload.explanation` was in before 1.12. A run stopped after several paid turns
recorded no spend at all, and because Rails copies `usage` off any terminal event, populating the
payload makes that spend land with no Rails change.

Consumers need no change. `web/src/stores/event_store.ts` deliberately ignores `run_interrupted`
when computing the context gauge and still may — that selector is about context pressure, not
billing.

## [changeset-payloads] — three declared fields are now actually populated (clarifying)

**No `CONTRACT_VERSION` bump: no type, field, or endpoint changed.** What changed is that the
payloads a real run produces finally match the schema they have always been declared against.

Found by running the acceptance walkthrough's S0 against the live stack. A real Bedrock run edited a
file, reached `awaiting_review` and was approved — and left a record that said almost nothing:

| event | contract | what a real run emitted |
|---|---|---|
| `changeset_ready` | `{files_changed, insertions, deletions}` | `{}` |
| `changeset_approved` | `{commit_sha}` | `{}` |

`ai_runs.base_sha` was also never written, though `Runs::Start`'s own comment says it records one.
That one is not cosmetic: `Git::LaneConflicts#commit_range_args` returns nil on a blank base, so a
conflict with a lane whose change is **already committed** was never reported .
Scope measured rather than assumed — the `unreviewed` kind diffs the working tree and needs no base,
so only the approved kind was silenced. `commit!` already RETURNED the sha `changeset_approved`
needed; `Runs::Approve` was discarding it.

Consumers need no change, and a consumer that was defensively treating these fields as
possibly-absent may now rely on them. `changeset_ready` reports zeros only if git becomes
uninspectable between the dirty check and the stat — the alternative was raising inside the ingest
transaction, which the surrounding dirty check already declines to do.

Why it hid for so long: `lane_conflicts_spec` sets `base_sha` in its own fixture, so it proved the
algorithm while production never fed it. The new guard in `changeset_payload_spec.rb` drives
detection from `Runs::Start` and was verified to fail without the fix.

## [1.14.0] — `participant_removed`, the 32nd event type (additive)

**`CONTRACT_VERSION = { major: 1, minor: 14 }`.** `EVENT_TYPE_COUNT` 31 → 32.

An owner can revoke a participant's access: `DELETE /api/sessions/:session_id/participants/:id`
(owner-only), appending `participant_removed { participant_id, name }`.

**Removal is a REVOCATION, not a delete, and the DATABASE settled that.** A hard `destroy` raises
`PG::ForeignKeyViolation` on `events.actor_participant_id`, because the event stream is append-only
and every message the participant sent references them. The constraint is right: erasing the row would
leave unattributable messages in the feed and an `ai_runs` row claiming a changeset was approved by
nobody. So `participants.removed_at` withdraws access while the row survives as the referent for
history.

Consequences worth stating:

- Their `chat_message` / `user_prompt` events stay in the feed, still attributed, and their approvals
  stay approved. Removal does not rewrite the past.
- `name` rides on the payload because the participant is no longer active and would not resolve — the
  same reason `participant_joined` carries one.
- **Participantship now means `participants.active`** (`removed_at IS NULL`), in both the REST check
  and the cable subscription. A check that forgets the scope grants a removed participant everything
  they had.
- An already-open cable socket survives until it reconnects; the next subscribe is refused.
- The session HOST cannot be removed — `sessions.host_id` would dangle and the room would have no
  administrator. Archive is the lever for closing a session.

**Revocation of an INVITE remains a different thing** and is unchanged: it stops future joins and
touches nobody who already joined.

## [1.13.0] — `run_started.lane`: which work stream a run belongs to (additive)

**`CONTRACT_VERSION = { major: 1, minor: 13 }`.** One new optional field on `RunStartedPayload`.

`lane?: string`, echoed for the same reason `disallowed_tools` is: it is the ONLY place a client —
including a late joiner arriving by backfill with no live events — can learn a run's lane. Every other
event carries just `ai_run_id`, so without this the feed could not label a row without a REST call per
run.

**Omitted for the default lane.** Absence means `main`, which is every session that has never opened
a second one, and labelling every row "main" in a single-lane session is noise.

The web renders it as a per-row chip in ONE ordered stream rather than splitting the feed:
's single ordered stream is the product's central claim, and interleaving is information — you
can see two lanes racing.

## [extensions] — per-session extension enablement; no third-party loading (additive)

**No `CONTRACT_VERSION` bump: no event type or payload changed.** `plugin_enabled` and
`plugin_disabled` have existed since 1.5.0 and are now actually emitted.

**New endpoints.** `GET /api/sessions/:id/plugins` (any participant) and
`PATCH /api/sessions/:id/plugins/:id` (owner). On the harness: `GET /plugins?session_id=` and
`POST /sessions/:id/plugins`. Both harness routes are bearer-authed like every other.

**Behaviour change worth noting.** `request_header`'s `plugins` field was hardcoded `[]`, so a session
that disabled a rule produced a snapshot identical to one that had it on. It now carries the resolved
set, sorted — the snapshot is fingerprinted, and iteration order must not make an unchanged set look
changed. A consumer diffing snapshots will start seeing this field vary.

**No install endpoint, deliberately.** A measurement showed that a `worker_thread` with `env: {}` isolates
the environment and nothing else.  is met by construction — no code path loads foreign code —
and `npm run test:plugin-adversarial` asserts that absence. `origin: "external"` stays in the
register's union so a record written by a future build remains readable; nothing produces it today.

**Toggles apply at the next run start**, not mid-run. See `harness_protocol.md` §10.

## [failure-hints] — a mid-run credential failure names the RIGHT fix (clarifying)

**No `CONTRACT_VERSION` bump: no type, field, or endpoint changed.** `provider_error` already carried
`kind`, `message` and `remedy` (1.5.0). What changed is which words a real host produces.

`classifyStreamError` hardcoded one remedy for every provider — "`claude setup-token` or a new API
key" — so a developer whose **AWS SSO session expired mid-run** was told to run a command that fixes
nothing. Confidently wrong advice, and the same defect [discovery-classification] fixed one layer up.

The loop now classifies the HTTP **status** (not vendor-specific) and the **adapter** supplies the
words, through a new optional `ProviderAdapter.failureHints { expired, notEntitled, unreachable }`.
The Bedrock adapters say `aws sso login`; the first-party ones reuse their existing `PROBE_HINTS`, so
a provider's mid-run message and its discovery message cannot drift apart.

**A 403 is now `not_entitled`, where it used to be `api_error`.** A valid-but-unentitled credential is
not fixed by re-authenticating, so its remedy must not suggest it — telling someone to log in again
sends them in a circle.

`failureHints` is OPTIONAL so a test double need not restate it, and the fallback is deliberately
vendor-NEUTRAL: an adapter that declares none produces vague advice rather than advice for somebody
else's credential. A test asserts every registered adapter declares its own, so the fallback is never
reached in production.

Consumers need no change — they already render whatever `kind`/`remedy` arrive.

## [lanes] — one active run per LANE; diff reports cross-lane conflicts (B5 lands)

**No `CONTRACT_VERSION` bump: no event type or payload changed.** This is the endpoint + schema half
of B5, which the migration window declared from the start ("one-active-run-per-session is lifted").

**Breaking, in-window (B5).** `ai_runs` gains `lane` (NOT NULL, default `main`) and
`index_ai_runs_one_active_per_session` is REPLACED by `index_ai_runs_one_active_per_lane` on
`(session_id, lane)`. A client that assumed at most one active run per session is wrong afterwards —
which is the point. No backfill: every existing run is already in the lane it was implicitly in.

**Additive on the wire.** `POST /runs` already accepted `lane` (B1); it is now enforced rather than
carried. `GET /api/runs/:id/diff` gains two keys:

- `lane` — which lane the changeset belongs to;
- `conflicts` — `[{ path, lane, kind }]`, `kind` ∈ `unreviewed` | `approved`. Always present, empty
  for a single-lane session, so a client need not distinguish "none" from "not reported".

**New refusal.** An invalid `lane` is `422`. Lane names reach a filesystem path and a git ref, so
they are validated against `/\A[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\z/` and **rejected rather than
sanitised** — a sanitised name silently addresses a different lane than the caller asked for.

See `harness_protocol.md` §8 for the worktree/branch layout, the `lane.leaf`/`lane.state` registers,
and why the branch suffix is a hyphen (a slash makes the ref a directory and git refuses to have
both `refs/heads/clawd/session-7` and `refs/heads/clawd/session-7/review`).

## [1.12.0] — `run_failed.explanation`: why the run failed, in words (additive)

**`CONTRACT_VERSION = { major: 1, minor: 12 }`.** Additive `minor` bump: one new REQUIRED field on
`RunFailedPayload`.

`explanation: string | null` carries what the participant needs to know. The loop has composed these
sentences since M4 — "the response hit its output limit and is incomplete", "a server-side tool did
not finish after 5 resumes", the refusal message — and `RunLoop.fail()` took the argument as
`_message` and **discarded it**. `run_failed` carried only `stop_reason`, so the room read "run
failed" and nothing more.

**Required, not optional, so the value must be STATED.** `null` means "considered, nothing to add";
an absent key and a null one read the same to a consumer, but only one of them proves the producer
answered the question. Same rule as `total_cost_usd` at 1.7.0 and `thinkingBudgetTokens` at 1.11.0.

**Why it matters most on Bedrock and Converse.** Both declare `serverSideRefusalFallback: false`,
which means a refusal arrives as HTTP 200 with a bare stop reason and NO content — so this string is
the only account of it that will ever exist. The harness now varies the message on that capability
(which previously had no reader at all): where the fallback exists it points at the model's own
words, and where it does not it says outright that the provider gave no reason and suggests
rephrasing or another provider.

Producers must add the field (a compile error until they do). Consumers may ignore it; `RunBanner`
renders it on its own line, because these are full sentences with an action in them and appending
one to a "run failed ·" line is how it gets ignored.

**Not** carried as a fabricated `ai_text`: that would attribute harness-authored prose to Claude and
fold it into the model-visible surface as though the model had said it.

## [compaction-request] — `ProviderRequest.compaction` is now actually sent (clarifying)

**No version bump: no type, field, or endpoint changed.** `ProviderRequest.compaction` has existed
since M4 and `context_compacted` since 1.5.0. What changed is that the field now reaches a provider.

`request_builder` set `compaction: true` whenever `capabilities().serverSideCompaction` was true,
and no adapter translated it into anything — the Anthropic `stream()` calls omitted it. So the
loop's `model_context_window_exceeded` → `{kind:"compact"}` → retry path was retrying a request
identical to the one that had just overflowed. `src/context/compaction.ts` now builds
`context_management.edits:[{type:"compact_20260112"}]` with beta `compact-2026-01-12` and the two
first-party adapters send it.

**Consumers unaffected, but one capability's MEANING changed.** `serverSideCompaction` was derived
as `context_management != null`, and that field is non-optional on the SDK's capability object — so
it was true for every model with capabilities at all. It now requires
`context_management.compact_20260112.supported`, so a client reading the capability to decide
whether to show a compaction affordance will see it false on models where it was previously (and
wrongly) true.

**The live request is unverified.** This host serves neither first-party Anthropic path, and
Bedrock declares no support, so the directive's acceptance by a real model has not been executed.
Everything downstream of the request is covered.

## [discovery-classification] — an adapter may name its own discovery failure (clarifying)

**No version bump: no type, field, or endpoint changed.** `ProviderStatus.reason` already carried
the full `ProviderUnavailableReason` union; what changed is which value a real host produces.

`GET /models` reports an unavailable provider with a `reason` and a `remedy`. When an
adapter's `listModels()` threw, discovery reported `reason: "unreachable"` with `String(err)` as the
remedy — correct for a network fault, wrong for a credential. On this host that meant an expired
AWS SSO session told the developer to check their network, when the fix was `aws sso login`.

An adapter may now throw `ProviderDiscoveryError(message, reason, remedy)` and discovery reports
those verbatim; anything else still becomes `unreachable`, which stays the honest answer for a
fault the code cannot name. **Only the adapter can classify** — the reason lives in a vendor's
error shape, and teaching the provider-agnostic layer to read AWS exception names would put vendor
knowledge exactly where the seam exists to keep it out.

Consumers need no change: they already render whatever `reason`/`remedy` arrive. What they gain is
that `credential_expired` and `not_entitled` now actually occur where previously only
`unreachable` did.

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

## [1.11.0] — `thinkingBudgetTokens`: the older extended-thinking shape (additive)

**`CONTRACT_VERSION = { major: 1, minor: 11 }`.** Additive `minor` bump: one new REQUIRED field on
`ProviderCapabilities`. Additive for consumers; a compile error for producers until each states a
value, which is the point — tsc found 28 sites.

```ts
interface ProviderCapabilities {
  adaptiveThinking: boolean;
  thinkingBudgetTokens: number | null;   // NEW
  ...
}
```

**Why.** An earlier fix stopped a 400 by omitting `thinking` entirely for the models that refuse
`{type:"adaptive"}` — which made them WORK, and left five Bedrock profiles (opus-4-1, opus-4-5,
sonnet-4, sonnet-4-5, haiku-4-5) running with **no extended thinking at all**. They support it; the
request type could not express their shape.

**The split is per MODEL on both sides, measured, and it is not a version cutoff:**

| shape accepted | profiles |
|---|---|
| `{type:"adaptive"}` only | `claude-opus-4-7` — *"thinking.type.enabled is not supported for this model"* |
| **both** | `claude-sonnet-4-6` |
| `{type:"enabled", budget_tokens}` only | opus-4-1, opus-4-5, sonnet-4, sonnet-4-5, haiku-4-5 |

So a second field rather than a widening of `adaptiveThinking`: the two are independent and overlap.
The field states what a model ACCEPTS; preferring `adaptive` where both are offered is policy and
lives in the request builder.

**This also corrects a note in `providers/contract.ts` (R10)**, which listed
`thinking.budget_tokens` alongside `temperature`/`top_p`/`top_k` as "returns 400 on current models".
True of opus-4-7, false of sonnet-4-6, and false of every older profile — where it is the only shape
that works. `temperature` stays absent for a sharper measured reason: with thinking enabled,
`temperature: 0.5` is refused outright ("`temperature` may only be set to 1 when thinking is
enabled"), so it is incompatible with the feature rather than merely useless.

**Two constraints travel with the field, both measured, and both are enforced when sizing a request:**
`budget_tokens` must be **≥ 1024** (512 → *"Input should be greater than or equal to 1024"*), and
`max_tokens` must be **strictly greater** than the budget (an equal pair is a 400). A model whose
output ceiling cannot hold the answer plus 1024 therefore gets NO thinking rather than an invalid
request — `ProviderRequest.thinking` is now a discriminated union, so `budget_tokens` on an adaptive
request is a type error instead of a 400.

**What producers should do.** State it. `null` is the safe default and means "does not take this
shape": omitting `thinking` works everywhere, so a wrong null costs a feature while a wrong number
costs the turn. Every Converse model is `null` — Converse has neither shape.

**Recovery / migration.** Nothing stored changes. Runs recorded before this bump were sent no
`thinking` field on those five profiles, which is exactly what they show.

## [protocol] — `allowed_tools` retired from `POST /runs` (breaking, in-window)

**No `CONTRACT_VERSION` bump** — endpoint/protocol changes are recorded here and do not move the
event contract's version. Breaking by classification, inert in practice.

`POST /runs` no longer accepts `allowed_tools`, and Rails no longer sends it.

**Why.** It was the Agent SDK's pre-approval list. When the SDK left, the harness kept ACCEPTING the
field and no code path read it — `supervisor.ts` declared it in `StartRunInput` and that was the only
mention. So Rails computed a whitelist on every run start and sent it into a void, while the protocol
document described it as active ("`allowed_tools` still pre-approves"). That is worse than a missing
feature: it is a documented guarantee with no implementation.

An allow-list only *pre-approves* in any case. The two things that actually bound a tool call are the
`tool:before` extension point and dropping the declaration outright (`disallowed_tools`, which itself
did nothing until CHANGELOG 1.8.0 gave it the right vocabulary).

**The constant survives, renamed.** `Runs::Start::DEFAULT_ALLOWED_TOOLS` is now `BUILTIN_TOOLS`: the
Ruby copy of `packages/contracts` `BUILTIN_TOOLS`, whose only remaining job is validating a
`disallowed_tools` selection. The old name promised an allow-list that no longer exists.

**Recovery / migration.** Nothing stored changes and no behaviour changes, because the field never had
any. A harness on older code ignores its absence exactly as it ignored its presence. This closes the
earlier scoping-audit finding: of the four per-run scoping fields, `disallowed_tools` works (1.8.0), `connectors` works
(1.9.0), `skills` works (1.10.0), and this one is gone.

## [1.10.0] — `skill_changed`, the 31st event type (additive)

**`CONTRACT_VERSION = { major: 1, minor: 10 }`.** Additive `minor` bump: one new event type, taking
the taxonomy from 30 names to **31**. `EVENT_TYPE_COUNT` and the Rails `TAXONOMY` size assertion both
had to be edited by hand, which is the point — a taxonomy that can grow unnoticed is one nobody can
rely on.

```ts
interface SkillChangedPayload {
  action: "added" | "removed" | "replaced";
  name: string;
  scope: "project" | "host";
  moved_to?: string;   // where a removed skill went; nothing is deleted
}
```

**Why an event at all.** The settings surface lets an owner add and remove host skills from the
browser. A skill is *instructions Claude will follow*, so adding one is closer to granting a
capability than to editing a document — and the room's other capability changes are all events. A
file's mtime does not say who.
SESSION-scoped, not run-scoped: it happens in settings, between runs, and it changes what a FUTURE
run can do.

**`scope` carries the blast radius.** A `project` skill affects one repo; a `host` skill affects every
session on the machine *and* the developer's own terminal Claude Code. The UI states that next to the
control, and the event records which was chosen.

**`moved_to` exists because removal does not delete.** The harness moves the directory to a sibling
`.claude/skills-removed/`, so an unwanted removal is recoverable — and the record says where to look.
Moving it OUT of `skills/` rather than renaming it in place was a correction found by live testing:
discovery keys on the frontmatter `name`, so a `deploy.removed` directory stayed listed, stayed in
every run's skill index, and stayed loadable by the `skill` tool. Removal was a no-op.

**Rendered, not just recorded.** The feed shows it as a banner naming the participant, the skill and
the scope ("Alice added the host-wide skill pdf"). An audit trail nobody reads is not an audit trail.

**What consumers should do.** Treat it like `participant_joined`: session-scoped, `ai_run_id` null,
durable. A client that does not know the type still renders the envelope safely (the `default` branch),
but the sentence is worth having.

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
