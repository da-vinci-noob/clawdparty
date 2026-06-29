## ADDED Requirements

### Requirement: Canonical event envelope

Every live occurrence in a session SHALL be represented as a single event envelope with exactly these fields: `id`, `session_id`, `ai_run_id`, `seq`, `type`, `actor`, `ts`, `payload`. The contract document `docs/contracts/events.md` and the shared type `packages/contracts/src/events.ts` SHALL both define this envelope, and `events.ts` SHALL be the machine-checked source of truth for its shape. The `payload` field SHALL be type-specific JSON; consumers that do not understand a `type` SHALL still be able to read the envelope fields.

The scalar type of each envelope field SHALL be pinned in the frozen `events.ts` now (these are freeze-now, not spike-gated — only per-type `payload` internals are deferred): `id` is an integer for durable (persisted) events — the server-assigned global cursor — and is **null for ephemeral events** (`ai_text_delta`, `presence_changed`), which are broadcast without a persisted row and therefore have no cursor; `seq` is an integer or null; `session_id` is a string id; `ai_run_id` is a string id or null; `type` is one of the frozen taxonomy names (or `ai_raw`); `ts` is an ISO-8601 UTC timestamp string with millisecond precision and a `Z` suffix (e.g. `2026-06-28T20:11:05.123Z`); `payload` is opaque JSON. Pinning `ts` as ISO-8601 with fixed millisecond precision (not epoch-ms, not variable fractional digits) avoids the classic cross-stream date-format mismatch.

`session_id` SHALL be present on every event. `ai_run_id` and `seq` SHALL be present for run-scoped events (those emitted by the sidecar during a run) and SHALL be null for session-scoped non-run events (`chat_message`, `participant_joined`, `presence_changed`, `task_created`, `task_updated`). The idempotency rule below therefore binds only run-scoped events.

#### Scenario: Envelope fields are present on every event type

- **WHEN** any event of any of the frozen types is produced
- **THEN** it carries `id`, `session_id`, `type`, `actor`, `ts`, and `payload`, and carries `ai_run_id` + `seq` when run-scoped (null otherwise)
- **AND** no live state is delivered to clients through any shape other than this envelope

#### Scenario: Envelope scalar types are pinned in the frozen events.ts

- **WHEN** the frozen `events.ts` envelope interface is defined
- **THEN** `id` is an integer for durable events and null for ephemeral events, `seq` is an integer or null, `session_id` is a string id, `ai_run_id` is a string id or null, `ts` is an ISO-8601 UTC string, and `payload` is opaque JSON
- **AND** only `payload` internals are deferred to the spike

#### Scenario: Unknown payload is still a valid envelope

- **WHEN** a consumer receives an event whose `type` it does not recognize
- **THEN** it can still read all envelope fields and treat `payload` as opaque JSON without erroring

### Requirement: Frozen event type taxonomy

The contract SHALL enumerate the frozen set of event type names. The taxonomy SHALL contain exactly these 20 names: `run_started`, `ai_text_delta`, `ai_text`, `ai_thinking`, `tool_started`, `tool_finished`, `tool_failed`, `terminal_output`, `file_changed`, `run_finished`, `run_failed`, `run_interrupted`, `changeset_ready`, `changeset_approved`, `changeset_rejected`, `chat_message`, `task_created`, `task_updated`, `participant_joined`, and `presence_changed`. Adding or removing a name SHALL require a contract change, so the count of exactly 20 SHALL be asserted to catch an accidental addition. The `ai_raw` fallback is NOT one of the 20: any SDK message the normalizer cannot map to a known type SHALL be emitted as `ai_raw` rather than dropped or crashing. Type names SHALL be referenced by downstream specs via this capability rather than re-enumerated, so a rename changes one place.

#### Scenario: Every taxonomy name is defined exactly once

- **WHEN** the contract is frozen
- **THEN** each type name appears in `docs/contracts/events.md` and in the `events.ts` type-name union
- **AND** the two lists agree

#### Scenario: The taxonomy holds exactly 20 names plus ai_raw

- **WHEN** the frozen `events.ts` type-name union is counted
- **THEN** it contains exactly 20 taxonomy names plus the `ai_raw` fallback (which is not one of the 20), so an accidental future addition without a contract change is caught

#### Scenario: Unmappable SDK message degrades to ai_raw

- **WHEN** the sidecar encounters an SDK message shape it cannot map to a known type
- **THEN** the contract requires it be emitted as an `ai_raw` event, never dropped and never a crash

### Requirement: Per-type actor, durability, and run-scope are frozen

For each of the 20 types (plus `ai_raw`), the contract SHALL freeze three axes now (these are freeze-now, not spike-gated — only per-type `payload` internals wait for the spike): `actor.kind`, durable-vs-ephemeral, and run-scoped-vs-session-scoped. Leaving these to inference would defeat the parallel-build guarantee, so the contract pins them in this table:

| type | actor.kind | durability | scope |
|---|---|---|---|
| `run_started` | user | durable | run |
| `ai_text_delta` | claude | **ephemeral** | run |
| `ai_text` | claude | durable | run |
| `ai_thinking` | claude | durable | run |
| `tool_started` | claude | durable | run |
| `tool_finished` | claude | durable | run |
| `tool_failed` | claude | durable | run |
| `terminal_output` | claude | durable | run |
| `file_changed` | claude | durable | run |
| `run_finished` | system | durable | run |
| `run_failed` | system | durable | run |
| `run_interrupted` | user | durable | run |
| `changeset_ready` | system | durable | run |
| `changeset_approved` | user | durable | run |
| `changeset_rejected` | user | durable | run |
| `chat_message` | user | durable | session |
| `task_created` | user | durable | session |
| `task_updated` | user | durable | session |
| `participant_joined` | user | durable | session |
| `presence_changed` | user | **ephemeral** | session |
| `ai_raw` | system | durable | run |

Run-scoped **durable** types carry `ai_run_id` + `seq`; session-scoped types carry null `ai_run_id`/`seq`. Ephemeral types are broadcast but never persisted, carry a null `id`, and **never consume `seq`** — so the run-scoped ephemeral `ai_text_delta` carries `ai_run_id` but a **null `seq`** (per the ephemeral-versus-durable requirement below).

#### Scenario: A run-lifecycle event is attributed to the system actor

- **WHEN** a `run_finished` or `run_failed` event is produced
- **THEN** its `actor.kind` is `system` per the frozen per-type table, distinct from the `user`-attributed `run_started`/`changeset_approved`/`changeset_rejected`

#### Scenario: A tool event is durable, run-scoped, and claude-attributed

- **WHEN** a `tool_started` event is produced
- **THEN** it is durable, run-scoped (carries `ai_run_id` + `seq`), and `actor.kind` is `claude`, per the frozen per-type table

### Requirement: Dual cursor semantics

The contract SHALL define two cursors. `seq` SHALL be a per-run monotonically increasing integer assigned by the sidecar and scoped to a single `ai_run_id`. The global `events.id` SHALL be a server-assigned monotonic identifier used as the client backfill/catch-up cursor across the whole session. Clients SHALL page and backfill on `id`; `seq` SHALL NOT be used as a cross-run cursor. `ts` SHALL be treated as **display-only**: ordering is by `id` (across the session) and by `seq` (within a run), never by `ts` — wall-clock timestamps can tie or skew and SHALL NOT determine event order.

#### Scenario: seq is per-run, id is global

- **WHEN** two different runs in the same session each emit events
- **THEN** each run's `seq` starts independently and increases monotonically within that run
- **AND** the global `id` increases monotonically across both runs and is what clients use to catch up

#### Scenario: seq restarts per run on revise/resume

- **WHEN** a revised run resumes a prior Claude session under a new `ai_run_id`
- **THEN** `seq` is scoped to the new `ai_run_id` and does not carry over from the prior run

### Requirement: Idempotent ingest keyed on (ai_run_id, seq)

The contract SHALL specify that, for run-scoped events, the pair `(ai_run_id, seq)` uniquely identifies a persisted event, making ingestion idempotent: a duplicate `(ai_run_id, seq)` SHALL be silently skipped so that sidecar retries and replays are safe. Session-scoped non-run events (with null `ai_run_id`/`seq`) are not part of this idempotency key — they are not retry traffic — so the uniqueness constraint binds only events with a non-null `ai_run_id`. Client-side stores SHALL dedupe **durable** events by `id`. **Ephemeral events have a null `id` and SHALL NOT be deduped by `id`**: `ai_text_delta` is accumulated by `(ai_run_id, block)` into the in-progress text — where `block` is a delta-payload field identifying the text block, whose exact representation is `pending-spike` — and `presence_changed` is applied last-writer-wins per participant.

#### Scenario: Duplicate (run, seq) is skipped on retry

- **WHEN** the sidecar re-POSTs a batch containing an event with an already-persisted `(ai_run_id, seq)`
- **THEN** the contract requires the duplicate be silently skipped, not inserted twice and not an error

#### Scenario: Clients dedupe durable events by id

- **WHEN** a client receives the same durable event `id` from both live cable and REST backfill
- **THEN** it applies the event once, deduped by `id`

#### Scenario: Ephemeral events are not deduped by id

- **WHEN** a client receives an ephemeral `ai_text_delta` or `presence_changed` event (null `id`)
- **THEN** it does not dedupe by `id`; deltas accumulate by `(ai_run_id, block)` (where `block` is a `pending-spike` delta-payload field) and `presence_changed` is last-writer-wins per participant

### Requirement: Ephemeral versus durable events

The contract SHALL classify each event type as ephemeral or durable. `ai_text_delta` and `presence_changed` SHALL be ephemeral — broadcast to subscribers but never persisted — and `ai_text_delta` SHALL be coalesced (~150ms) in the sidecar before broadcast. All other listed types SHALL be durable. `ai_text` SHALL be the durable record emitted on text-block stop. The classification SHALL be explicit in the contract so all streams agree without rediscovering it.

Ephemeral does not mean unordered. `ai_text_delta` is **run-scoped and ephemeral**: it carries a non-null `ai_run_id` and a **null `id`**, and SHALL NOT consume the durable per-run `seq` (so it carries a **null `seq`**; `seq` is assigned only to durable run-scoped events, and the next durable event takes the next `seq` as though the delta had not been emitted). Deltas are ordered and accumulated client-side by `(ai_run_id, block)`, not by `seq` — consistent with the idempotency requirement below. `presence_changed` is **session-scoped and ephemeral**: it carries null `ai_run_id`/`seq`/`id`. So a **null `id` marks ephemerality, and ephemeral events never consume `seq`**.

#### Scenario: ai_text_delta carries a null seq and null id

- **WHEN** an `ai_text_delta` is produced during a run
- **THEN** it carries its `ai_run_id` but a null `seq` and null `id` (never persisted, does not advance the durable per-run counter), and clients order/accumulate deltas by `(ai_run_id, block)` rather than by `seq`

#### Scenario: Ephemeral events are broadcast but not stored

- **WHEN** an `ai_text_delta` or `presence_changed` event is produced
- **THEN** the contract requires it be broadcast to subscribers and NOT written to the event store

#### Scenario: Durable text is the block-stop record

- **WHEN** a text block completes
- **THEN** a durable `ai_text` event is produced and persisted, distinct from the ephemeral deltas that preceded it

### Requirement: Actor attribution

Every event SHALL carry an `actor` that is a discriminated union on `kind`: `{ kind: "claude" } | { kind: "user"; id: string } | { kind: "system" }`. The `id` field SHALL be present if and only if `kind` is `"user"`, where `id` is the originating participant's id. `actor` SHALL carry the participant **id**, not a display name (names are resolved client-side from the participants list) and not the participant's role (resolved from the participant and enforced server-side). The shape SHALL be defined identically in `docs/contracts/events.md` and `packages/contracts/src/events.ts`.

#### Scenario: User-originated event carries a participant id

- **WHEN** a human-originated event (such as `chat_message`, `participant_joined`, `run_started`, or `changeset_approved`) is produced
- **THEN** its `actor` is `{ kind: "user", id }` carrying the originating participant's id, and the client resolves the display name from that id

#### Scenario: Claude and system events carry no id

- **WHEN** a Claude-originated event (such as `ai_text`) or a system-originated event (such as a crash-driven `run_failed`) is produced
- **THEN** its `actor` is `{ kind: "claude" }` or `{ kind: "system" }` respectively, with no `id` field

#### Scenario: id presence is bound to kind

- **WHEN** the contract type for `actor` is defined
- **THEN** it makes `id` required exactly when `kind` is `"user"` and absent otherwise, so an actor with a mismatched `kind`/`id` combination fails type-checking

### Requirement: Payload schemas are spike-gated, not absent

For each event type, the contract SHALL either define the concrete `payload` schema or explicitly mark it `pending-spike`. Payload schemas SHALL NOT be silently omitted. Per-type payload field schemas SHALL be finalized at the Wednesday Week-1 freeze using real SDK spike output; the envelope and type names SHALL be frozen independently of the spike.

#### Scenario: Unfinalized payload is explicitly marked pending

- **WHEN** the contract is published before the spike output is incorporated
- **THEN** each type whose payload is not yet final is marked `pending-spike` rather than left undefined

#### Scenario: Envelope freezes without waiting on payloads

- **WHEN** payload schemas are still `pending-spike`
- **THEN** the envelope fields, type names, and cursor/idempotency/ephemeral rules are nonetheless frozen and usable by downstream streams
