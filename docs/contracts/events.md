# Contract 1 — Event envelope & taxonomy

> **Status:** envelope, type names, per-type axes (actor / durability / scope), cursor &
> idempotency rules, and the ephemeral-vs-durable rule are **FROZEN** (v1.0). Per-type `payload`
> field schemas were **finalized at v1.1** from real SDK spike output (see §8 + `sdk_mapping.md`).
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
  "type":       "ai_text",                 // one of the 20 names, or "ai_raw"
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
| `id` | `integer \| null` | Server-assigned global cursor for **durable** events. **`null` for ephemeral events** (`ai_text_delta`, `presence_changed`) — they are broadcast, never persisted, and therefore have no cursor. A null `id` is the marker of ephemerality. |
| `session_id` | `string` | Present on **every** event. |
| `ai_run_id` | `string \| null` | Present for **run-scoped** events (emitted by the sidecar during a run). `null` for **session-scoped** events (`chat_message`, `participant_joined`, `presence_changed`, `task_created`, `task_updated`). |
| `seq` | `integer \| null` | Per-run monotonic counter (see §4). Present for **durable run-scoped** events. **`null`** for ephemeral events (incl. the run-scoped `ai_text_delta`) and for session-scoped events. |
| `type` | `string` | One of the 20 frozen names (§2) or the `ai_raw` fallback (§3). |
| `actor` | object | Discriminated union on `kind` (§6). |
| `ts` | `string` | ISO-8601 UTC, **millisecond precision**, `Z` suffix (e.g. `2026-06-28T20:11:05.123Z`). **Display-only** — never used to order events (§4). Fixed ms precision avoids the classic cross-stream date-format mismatch. |
| `payload` | JSON | Type-specific; per-type field schemas finalized at v1.1 (§8 + `sdk_mapping.md`). |

## 2. The frozen taxonomy — exactly 21 names

```
run_started        user_prompt      ai_text_delta    ai_text
ai_thinking        tool_started     tool_finished    tool_failed
terminal_output    file_changed     run_finished     run_failed
run_interrupted    changeset_ready  changeset_approved  changeset_rejected
chat_message       task_created     task_updated     participant_joined
presence_changed
```

Adding or removing a name is a **contract change** (CHANGELOG entry; see §8). The count of
**exactly 21** is asserted in `events.ts` (`EVENT_TYPE_COUNT: 21`) so an accidental addition
fails type-checking. Downstream specs reference this list **by name** rather than re-enumerating
it, so a rename changes one place. (`user_prompt` was added additively at v1.2 — see CHANGELOG.)

## 3. The `ai_raw` fallback (not one of the 21)

Any SDK message the normalizer cannot map to a known type is emitted as **`ai_raw`** — never
dropped, never a crash. It is **not** a member of the 21-name taxonomy; it is the safety valve
that keeps the normalizer total over an evolving SDK surface.

## 4. Two cursors — `seq` (per-run) and `id` (global)

| cursor | assigned by | scope | used for |
|---|---|---|---|
| `seq` | sidecar | a single `ai_run_id` | ingest idempotency on `(ai_run_id, seq)` (§5); ordering **within a run** |
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
the duplicate — not inserted twice, not an error — so sidecar retries and replays are safe. The
uniqueness constraint binds only events with a non-null `ai_run_id`; session-scoped events
(null `ai_run_id`/`seq`) are not retry traffic and are not part of this key.

Client stores **dedupe durable events by `id`** (the same durable event can arrive from both live
cable and REST backfill — apply once). **Ephemeral events have a null `id` and are NOT deduped by
`id`** — see §6.

## 6. Ephemeral vs durable, and per-type axes

`ai_text_delta` and `presence_changed` are **ephemeral**: broadcast to subscribers but **never
persisted**. `ai_text_delta` is coalesced (~150 ms) in the sidecar before broadcast; `ai_text`
is the **durable** record emitted on text-block stop. All other types are durable.

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
> **payload internals** were finalized at v1.1 (§8 + `sdk_mapping.md`).

| type | actor.kind | durability | scope | carries |
|---|---|---|---|---|
| `run_started` | user | durable | run | `ai_run_id` + `seq` |
| `user_prompt` | **user** | durable | run | `ai_run_id` + `seq` |
| `ai_text_delta` | claude | **ephemeral** | run | `ai_run_id`; **null `seq`**, null `id` |
| `ai_text` | claude | durable | run | `ai_run_id` + `seq` |
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
| `ai_raw` | system | durable | run | `ai_run_id` + `seq` |

Note the deliberate splits: run lifecycle is **system** (`run_finished`/`run_failed`) except
`run_interrupted`, which is a **human** action and so is **user**-attributed; `run_started`,
`changeset_approved`, and `changeset_rejected` are also **user** acts.

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
from the captured raw messages, live in **[`sdk_mapping.md`](./sdk_mapping.md)** (the single source)
and are typed in [`packages/contracts/src/events.ts`](../../packages/contracts/src/events.ts)
(`EventPayloadMap`, with one interface per type). The `ai_text_delta` `block` field is resolved to
`"<assistant_message_uuid>:<content_block_index>"`. The **envelope, type names,
cursor/idempotency/ephemeral rules, and per-type axes were frozen at v1.0 independently of the
spike**; finalizing the payloads is an **additive** `minor` bump (see
[`CHANGELOG.md`](./CHANGELOG.md) `[1.1.0]`), not a breaking change.

[`fixtures/sample_run.jsonl`](../../packages/contracts/fixtures/sample_run.jsonl) is the real
spike-derived executable contract (concrete payloads), replacing the v1.0 envelope-only placeholder.

**`user_prompt` (added v1.2 — sidecar-originated, not spike-derived):** payload
`UserPromptPayload { text: string }` — the human's prompt text for the initial prompt and each
follow-up. Attribution is on the envelope `actor` (`{ kind: "user", id }`), not the payload. Unlike
the spike-derived types above, `user_prompt` is **not** a mapping of any SDK message — the sidecar
synthesizes it from the prompt it pushes into the SDK input (see `sdk_mapping.md`).

## 9. Freeze history: v1.0 (envelope) vs v1.1 (payloads)

| frozen at v1.0 (envelope) | finalized at v1.1 (from the spike) |
|---|---|
| envelope fields + scalar types | per-type `payload` field schemas |
| the type names + `ai_raw` (21 as of v1.2) | concrete `events.ts` payload interfaces |
| per-type actor / durability / scope | `ai_text_delta` `block` representation |
| `(ai_run_id, seq)` idempotency, dual cursor | `fixtures/sample_run.jsonl` (real capture) |
| ephemeral-vs-durable rule, `actor` union | (additive `minor` bump — envelope unchanged) |
