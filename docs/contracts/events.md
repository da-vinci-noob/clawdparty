# Contract 1 — Event envelope & taxonomy

> **Status:** envelope, type names, per-type axes (actor / durability / scope), cursor &
> idempotency rules, and the ephemeral-vs-durable rule are **FROZEN** (v1.0). Per-type `payload`
> field schemas were **finalized at v1.1** from real SDK spike output (see §8 + `provider_event_mapping.md`).
> Every change after the freeze is recorded in [`CHANGELOG.md`](./CHANGELOG.md).
>
> **Machine-checked source of truth for SHAPE:** [`packages/contracts/src/events.ts`](../../packages/contracts/src/events.ts).
> This doc is authoritative for INTENT. If the two disagree, fix the drift and changelog it.

## 1. The envelope

Every live occurrence in a session — text, thinking, tool activity, terminal output, file
changes, run lifecycle, changeset state, chat, tasks, participants, presence — is delivered as
exactly **one envelope**. There are no bespoke cable messages (see
[`http_api.md`](./http_api.md)).

```jsonc
{
  "id":         123,                       // global cursor — see §4
  "session_id": "sess_01H...",             // present on EVERY event
  "ai_run_id":  "run_01HX...",             // run-scoped events only; null otherwise
  "seq":        7,                          // per-run monotonic; null for ephemeral/session
  "type":       "ai_text",                 // one of the 30 names, or "ai_raw"
  "actor":      { "kind": "claude" },      // discriminated union — see §6
  "ts":         "2026-06-28T20:11:05.123Z",// ISO-8601 UTC, ms precision, Z — DISPLAY ONLY
  "payload":    { /* type-specific */ }     // opaque to consumers that don't know `type`
}
```

A consumer that does not recognize `type` **must still** be able to read every envelope field
and treat `payload` as opaque JSON without erroring.

### Field reference (scalar types are frozen now — not spike-gated)

| field | type | rule |
|---|---|---|
| `id` | `integer \| null` | Server-assigned global cursor for **durable** events. **`null` for ephemeral events** (the four in `EPHEMERAL_EVENT_TYPES`: `ai_text_delta`, `ai_thinking_delta`, `presence_changed`, `context_usage`) — they are broadcast, never persisted, and therefore have no cursor. A null `id` is the marker of ephemerality. |
| `session_id` | `string` | Present on **every** event. |
| `ai_run_id` | `string \| null` | Present for **run-scoped** events (emitted by the harness during a run). `null` for **session-scoped** events (`chat_message`, `participant_joined`, `presence_changed`, `task_created`, `task_updated`, `plugin_enabled`, `plugin_disabled`). |
| `seq` | `integer \| null` | Per-run monotonic counter (see §4). Present for **durable run-scoped** events. **`null`** for ephemeral events (incl. the run-scoped `ai_text_delta` and `context_usage`) and for session-scoped events. |
| `type` | `string` | One of the 30 frozen names (§2) or the `ai_raw` fallback (§3). |
| `actor` | object | Discriminated union on `kind` (§6). |
| `ts` | `string` | ISO-8601 UTC, **millisecond precision**, `Z` suffix (e.g. `2026-06-28T20:11:05.123Z`). **Display-only** — never used to order events (§4). Fixed ms precision avoids the classic cross-stream date-format mismatch. |
| `payload` | JSON | Type-specific; per-type field schemas finalized at v1.1 (§8 + `provider_event_mapping.md`). |

## 2. The frozen taxonomy — exactly 30 names

```
run_started        user_prompt      ai_text_delta    ai_text
ai_thinking_delta  ai_thinking      tool_started     tool_finished
tool_failed        terminal_output  file_changed     run_finished
run_failed         run_interrupted  changeset_ready  changeset_approved
changeset_rejected chat_message     task_created     task_updated
participant_joined presence_changed

  ── harness types, added at v1.5 ──
request_header     context_compacted context_usage   tool_refused
plugin_enabled     plugin_disabled   provider_error  recovery_applied
```

Adding or removing a name is a **contract change** (CHANGELOG entry; see §8). The count of
**exactly 30** is asserted in `events.ts` (`EVENT_TYPE_COUNT: 30`) so an accidental addition
fails type-checking, and `Event::TAXONOMY` on the Rails side is asserted **equal to this list**
rather than merely the same length. Downstream specs reference the list **by name** rather than
re-enumerating it, so a rename changes one place.

Growth history: 20 at v1.0 → 21 (`user_prompt`, v1.2) → 22 (`ai_thinking_delta`, v1.3) → 30
(the eight harness types, v1.5). Each step is additive with a `minor` bump; see CHANGELOG.

> Why 30 and not 29: `harness_http.md` lists the v1.5 additions in **seven table rows**, because
> `plugin_enabled` and `plugin_disabled` share one. Eight names, seven rows.

## 3. The `ai_raw` fallback (not one of the 30)

Any provider message the normalizer cannot map to a known type is emitted as **`ai_raw`** — never
dropped, never a crash. It is **not** a member of the 30-name taxonomy; it is the safety valve
that keeps the normalizer total over an evolving provider surface.

## 4. Two cursors — `seq` (per-run) and `id` (global)

| cursor | assigned by | scope | used for |
|---|---|---|---|
| `seq` | harness | a single `ai_run_id` | ingest idempotency on `(ai_run_id, seq)` (§5); ordering **within a run** |
| `id` | Rails (autoincrement) | the whole session | the client **backfill / catch-up cursor**; ordering **across the session** |

- Clients page and backfill on **`id`** — `GET /api/sessions/:id/events?after=<cursor>`. `seq`
  is **never** used as a cross-run cursor.
- `seq` is **per-run** and restarts at the start of each run. A revised run that resumes a prior
  Claude session does so under a **new `ai_run_id`**, and `seq` starts fresh for it — it does not
  carry over (the uniqueness key is `(ai_run_id, seq)`).
- `ts` is **display-only**. Ordering is by `id` (session) and `seq` (run), **never** by `ts` —
  wall-clock timestamps can tie or skew and must not determine order.

## 5. Idempotent ingest, keyed on `(ai_run_id, seq)`

For **run-scoped durable** events, the pair `(ai_run_id, seq)` uniquely identifies a persisted
event. Re-POSTing a batch containing an already-persisted `(ai_run_id, seq)` **silently skips**
the duplicate — not inserted twice, not an error — so harness retries and replays are safe. The
uniqueness constraint binds only events with a non-null `ai_run_id`; session-scoped events
(null `ai_run_id`/`seq`) are not retry traffic and are not part of this key.

Client stores **dedupe durable events by `id`** (the same durable event can arrive from both live
cable and REST backfill — apply once). **Ephemeral events have a null `id` and are NOT deduped by
`id`** — see §6.

## 6. Ephemeral vs durable, and per-type axes

`ai_text_delta`, `ai_thinking_delta`, `presence_changed`, and `context_usage` are **ephemeral**:
broadcast to subscribers but **never persisted**. `ai_text_delta`/`ai_thinking_delta` stream
Claude's text/thinking live; `ai_text`/`ai_thinking` are the **durable** records emitted on block
stop. `context_usage` streams live context pressure; the durable per-run figure lives on
`run_finished`/`run_failed`. All other types are durable.

The set is exported as data — `EPHEMERAL_EVENT_TYPES` in `events.ts` — because **three**
independent places must agree on it: the harness (what to broadcast without a `store_seq`), Rails
`Event::EPHEMERAL_TYPES` (what not to persist), and the web store (what not to dedupe by `id`). A
type missing from the Rails list is **persisted and handed a durable `id`**, silently violating the
rule below. Do not re-declare the list in a fourth place; import it.

**Because ephemerals carry no cursor, ORDER IS A PROPERTY OF DELIVERY.** A client cannot sort
what has no sort key, so it concatenates deltas in arrival order and the two obligations below
are not optional:

- **The harness sends ephemerals single-file** — coalesced into ~150ms batches per
  `(type, session_id, ai_run_id, block)` and one request in flight at a time
  (`harness/src/transport.ts`). One unawaited POST per delta reordered the words of a sentence
  under ordinary latency variance. Only the accumulating types (`ai_text_delta`,
  `ai_thinking_delta`) may be merged: `presence_changed` and `context_usage` are whole values
  where the newest reading is the truth.
- **A client MUST drop a delta for a block that already settled.** Ephemeral and durable events
  travel over two independent channels, so `ai_text` routinely arrives before the tail of its own
  delta stream. A client that re-creates the live accumulator on a late delta renders the block
  twice — once settled, once as a fragment. Settling a block is therefore terminal for its
  deltas, not merely a signal to clear the accumulator.

**Ephemeral ≠ unordered, and ephemeral never consumes `seq`:**

- `ai_text_delta` is **run-scoped & ephemeral** — carries its `ai_run_id`, but a **null `seq`**
  and **null `id`**. It does **not** advance the durable per-run counter (the next durable event
  takes the next `seq` as though the delta had not been emitted). Clients order/accumulate deltas
  by **`(ai_run_id, block)`** — where `block` identifies the in-progress text block — **not** by
  `seq`. (Resolved at v1.1: `block` = `"<assistant_message_uuid>:<content_block_index>"`; it is the
  key the Week-2 web reducer accumulates by.)
- `presence_changed` is **session-scoped & ephemeral** — null `ai_run_id`/`seq`/`id`; applied
  **last-writer-wins per participant**.

A **null `id` marks ephemerality.** Ephemeral events bypass REST backfill and are not deduped by
`id`.

### Per-type table — actor / durability / scope are FROZEN

> The three axes below were frozen at v1.0 so the three streams agree without inference; each row's
> **payload internals** were finalized at v1.1 (§8 + `provider_event_mapping.md`).

| type | actor.kind | durability | scope | carries |
|---|---|---|---|---|
| `run_started` | user | durable | run | `ai_run_id` + `seq` |
| `user_prompt` | **user** | durable | run | `ai_run_id` + `seq` |
| `ai_text_delta` | claude | **ephemeral** | run | `ai_run_id`; **null `seq`**, null `id` |
| `ai_text` | claude | durable | run | `ai_run_id` + `seq` |
| `ai_thinking_delta` | claude | **ephemeral** | run | `ai_run_id`; **null `seq`**, null `id` |
| `ai_thinking` | claude | durable | run | `ai_run_id` + `seq` |
| `tool_started` | claude | durable | run | `ai_run_id` + `seq` |
| `tool_finished` | claude | durable | run | `ai_run_id` + `seq` |
| `tool_failed` | claude | durable | run | `ai_run_id` + `seq` |
| `terminal_output` | claude | durable | run | `ai_run_id` + `seq` |
| `file_changed` | claude | durable | run | `ai_run_id` + `seq` |
| `run_finished` | **system** | durable | run | `ai_run_id` + `seq` |
| `run_failed` | **system** | durable | run | `ai_run_id` + `seq` |
| `run_interrupted` | **user** | durable | run | `ai_run_id` + `seq` |
| `changeset_ready` | system | durable | run | `ai_run_id` + `seq` |
| `changeset_approved` | user | durable | run | `ai_run_id` + `seq` |
| `changeset_rejected` | user | durable | run | `ai_run_id` + `seq` |
| `chat_message` | user | durable | session | null `ai_run_id`/`seq` |
| `task_created` | user | durable | session | null `ai_run_id`/`seq` |
| `task_updated` | user | durable | session | null `ai_run_id`/`seq` |
| `participant_joined` | user | durable | session | null `ai_run_id`/`seq` |
| `presence_changed` | **user** | **ephemeral** | session | null `ai_run_id`/`seq`/`id` |
| `request_header` | **system** | durable | run | `ai_run_id` + `seq` |
| `context_compacted` | **system** | durable | run | `ai_run_id` + `seq` |
| `context_usage` | **system** | **ephemeral** | run | `ai_run_id`; **null `seq`**, null `id` |
| `tool_refused` | **system** | durable | run | `ai_run_id` + `seq` |
| `plugin_enabled` | **user** | durable | **session** | null `ai_run_id`/`seq` |
| `plugin_disabled` | **user** | durable | **session** | null `ai_run_id`/`seq` |
| `provider_error` | **system** | durable | run | `ai_run_id` + `seq` |
| `recovery_applied` | **system** | durable | run | `ai_run_id` + `seq` |
| `ai_raw` | system | durable | run | `ai_run_id` + `seq` |

> **`seq` is the RECORD's numbering, and RAILS-APPENDED events carry none.** The table's `carries`
> column describes the normal case: the harness emitted it, so the record holds the entry the number
> belongs to. Rails also appends four run-scoped types itself, and those arrive with `ai_run_id` and
> a **null `seq`** — `run_failed` from the staleness sweep and from boot reconciliation, and
> `run_interrupted` when an interrupt reaches a harness that no longer holds the run.
>
> This is not a loosening; it closes a defect. Rails computed its "next" seq from the PROJECTION,
> which is behind the record by definition, so the value was always one the harness might still use —
> and when it did, the insert lost to `UNIQUE (ai_run_id, seq)` and `Events::Ingest` reported the
> loser as `skipped`, indistinguishable from a retry. It destroyed `recovery_applied` on every real
> crash. `seq` and `store_seq` are both properties of the record; an event Rails appended
> holds neither, which is also what makes `rederive(reset:)` preserve it rather than delete it.
>
> `changeset_ready`/`approved`/`rejected` DO carry a seq, and that is safe rather than inconsistent:
> those fire only when the run is terminal from the harness's side, and the terminal entry and the
> terminal position marker are written in ONE `store.commit` — so recovery can never allocate again
> for that run. There the uniqueness also does real work, stopping two concurrent reviewers from
> appending twice.

Note the deliberate splits: run lifecycle is **system** (`run_finished`/`run_failed`) except
`run_interrupted`, which is a **human** action and so is **user**-attributed; `run_started`,
`changeset_approved`, and `changeset_rejected` are also **user** acts.

The v1.5 harness types follow the same logic. They are **system** because the harness itself acted
— it chose what to send, refused a tool, hit a provider error, recovered — with two exceptions:
`plugin_enabled`/`plugin_disabled` are a **human's** decision, so they are **user**-attributed and
**session-scoped**, because enabling a plugin is a property of the room rather than of whatever run
happens to be open.

`request_header` is emitted **per provider request, not per run**. An agentic run makes many, so
several `request_header` events within one run is the correct shape, not a duplicate.

## 7. Actor attribution

`actor` is a discriminated union on `kind`:

```ts
type Actor =
  | { kind: "claude" }
  | { kind: "user"; id: string }   // id present IFF kind === "user"
  | { kind: "system" };
```

`id` is present **if and only if** `kind === "user"`, and is the originating **participant's id**
— **not** a display name (resolved client-side from the participants list) and **not** a role
(resolved from the participant and enforced server-side regardless of what an event claims). The
discriminated union makes a mismatched `kind`/`id` combination fail type-checking.

## 8. Payload schemas — FINALIZED from the spike (v1.1)

Per-type `payload` field schemas were **finalized at `CONTRACT_VERSION` 1.1** (`sdk-message-spike`)
from real SDK output — they are no longer `pending-spike`. The concrete per-type schemas, derived
from the captured raw messages, live in **[`provider_event_mapping.md`](./provider_event_mapping.md)** (the single source)
and are typed in [`packages/contracts/src/events.ts`](../../packages/contracts/src/events.ts)
(`EventPayloadMap`, with one interface per type). The `ai_text_delta` `block` field is resolved to
`"<assistant_message_uuid>:<content_block_index>"`. The **envelope, type names,
cursor/idempotency/ephemeral rules, and per-type axes were frozen at v1.0 independently of the
spike**; finalizing the payloads is an **additive** `minor` bump (see
[`CHANGELOG.md`](./CHANGELOG.md) `[1.1.0]`), not a breaking change.

[`fixtures/sample_run.jsonl`](../../packages/contracts/fixtures/sample_run.jsonl) is the executable
contract (concrete payloads), replacing the v1.0 envelope-only placeholder. It was originally captured
from an Agent SDK spike; since that SDK is gone it is **GENERATED from a real harness run**
(`cd harness && npm run capture:fixture`, byte-stable) — see CHANGELOG `B8`. Five types it carries have
no emitter yet and are appended from `fixtures/not_yet_emitted.jsonl`.

**`user_prompt` (added v1.2 — synthesized by the harness, not mapped from a provider message):** payload
`UserPromptPayload { text: string }` — the human's prompt text for the initial prompt and each
follow-up. Attribution is on the envelope `actor` (`{ kind: "user", id }`), not the payload. Unlike
the provider-mapped types above, `user_prompt` is **not** a mapping of any provider message — the
harness synthesizes it from the prompt it pushes into the input stream.

### Synthesized types — no provider message produces them

`user_prompt` plus all eight v1.5 types are **synthesized**: the harness emits them from its own
state, and no provider transcript contains them. The set is exported as `SYNTHESIZED_EVENT_TYPES`
because the normalizer cross-check must exclude them **explicitly** when comparing a captured
transcript against the fixture. Before v1.5 that filter was "durable and run-scoped", which worked
only by coincidence — the fixture happened to contain no durable run-scoped synthesized events. A
guard that passes by coincidence is not a guard.

### v1.5 payloads

| type | payload | notes |
|---|---|---|
| `request_header` | `{ provider, credential_source, model, effort, system_prompt_digest, tool_schemas_digest, plugins[] }` | Digests, not contents. `credential_source` is a source **identity** (`CredentialSourceId`) — **never a value**. That is the whole point of the field: it makes "which login did this run use?" answerable without a credential entering the record. |
| `context_compacted` | `{ replaced_from_seq, replaced_to_seq, tokens_before, summary_present }` | The replaced range is named by `seq` so the projection can show what collapsed. `summary_present: false` is a **real case** — a provider may compact without returning a summary block, and that must not be reported as a summary. |
| `context_usage` | `{ input, output, cache_read, cache_creation, window }` | **Ephemeral.** `window` is the real budget for the model in use, read from the adapter's `capabilities()` — never a hardcoded constant, since it varies per provider and model. |
| `tool_refused` | `{ tool_use_id, name, by, reason }` | `by` names *what* refused (a policy, a plugin id, a participant) so a refusal is attributable instead of appearing as an unexplained gap in the run. |
| `plugin_enabled` / `plugin_disabled` | `{ id, version, origin, by }` | `origin` is `"builtin"` or `"third_party"`. Session-scoped. |
| `provider_error` | `{ provider, kind, message, remedy }` | `remedy` is **required and must be actionable** — a broken credential naming itself and its fix is the requirement . A generic string here is a contract violation, not a lazy default. |
| `recovery_applied` | `{ run_id, from_phase, action, uncertain }` | `uncertain: true` is the load-bearing value: when the harness died between dispatching a request and recording its outcome, the fate is genuinely unknown and the feed must **say so** rather than implying either outcome. Never default it to `false` to simplify a display. |

## 9. Freeze history

| frozen at v1.0 (envelope) | finalized at v1.1 (from the spike) |
|---|---|
| envelope fields + scalar types | per-type `payload` field schemas |
| `actor` union, per-type actor / durability / scope | concrete `events.ts` payload interfaces |
| `(ai_run_id, seq)` idempotency, dual cursor | `ai_text_delta` `block` representation |
| ephemeral-vs-durable rule | `fixtures/sample_run.jsonl` (generated from a harness run) |

The **taxonomy itself was never frozen against growth** — only against silent growth. It has gone
20 → 21 (v1.2) → 22 (v1.3) → 30 (v1.5), each time additively with a CHANGELOG entry and a `minor`
bump. What is frozen is the envelope: no field has been added, removed, renamed, or retyped since
v1.0, and `major` is still 1.
