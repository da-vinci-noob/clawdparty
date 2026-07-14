# user-prompt-event Specification

## Purpose
TBD - created by archiving change user-prompt-event. Update Purpose after archive.
## Requirements
### Requirement: `user_prompt` is a frozen-taxonomy event type added additively

The contract SHALL add `user_prompt` as a durable, run-scoped event type to the frozen taxonomy without
altering the envelope, scalar field types, or the `Actor` union. The addition MUST be additive per the
contract's own change rule: `CONTRACT_VERSION` bumps `minor` only (`{ major: 1, minor: 1 }` →
`{ major: 1, minor: 2 }`), the taxonomy count guard updates from 20 to 21, and a `docs/contracts/CHANGELOG.md`
entry records it. The payload SHALL be `{ text: string }` (the human's prompt text); attribution lives in the
envelope `actor`, never in the payload.

#### Scenario: The type and payload are part of the typed contract

- **WHEN** the `@clawdparty/contracts` package is built
- **THEN** `EVENT_TYPES` includes `"user_prompt"`, `EventPayloadMap.user_prompt` is `{ text: string }`, the
  `EVENT_TYPE_COUNT` freeze guard asserts 21, and the payload-map-covers-taxonomy guard still holds

#### Scenario: The version bump is additive, not breaking

- **WHEN** the change is published
- **THEN** `CONTRACT_VERSION` equals `{ major: 1, minor: 2 }` and a `docs/contracts/CHANGELOG.md` entry
  describes the addition
- **AND** a consumer requiring `major === 1` and `minor >= 1` still passes its compatibility check

### Requirement: The sidecar emits `user_prompt` run-scoped before each user message reaches the SDK

The sidecar SHALL emit exactly one `user_prompt` event for each human message it pushes into the SDK
streaming-input iterable — once for the initial prompt at run start and once per follow-up — and MUST emit it
**before** pushing the corresponding message, so the prompt's `seq` precedes any output it triggers. Each
emitted event MUST be run-scoped (`ai_run_id` = the run id, non-null per-run monotonic `seq` from the sidecar's
sequence), carry `actor` `{ kind: "user", id: <requested_by> }`, type `"user_prompt"`, and payload
`{ text: <message text> }`. The sidecar SHALL NOT assign these events a global `id` (Rails assigns `id` on
ingest, as for every run-scoped durable event).

#### Scenario: Initial prompt is emitted first on a fresh run

- **WHEN** a run starts with prompt text `P`
- **THEN** the sidecar emits a `user_prompt` event with payload `{ text: P }` and `seq` 1, attributed to the
  requesting participant
- **AND** the `run_started` event (from the SDK init message) follows it with `seq` 2

#### Scenario: Each follow-up emits its own `user_prompt`

- **WHEN** a follow-up message `F` is sent to the active run
- **THEN** the sidecar emits exactly one `user_prompt` event with payload `{ text: F }`, run-scoped with the
  next monotonic `seq`, attributed to the participant who sent it
- **AND** that event is emitted before `F` is pushed into the SDK input iterable

#### Scenario: It is durable, not ephemeral

- **WHEN** the sidecar ships a `user_prompt` event to Rails
- **THEN** it travels on the durable (batched, retried) transport path, never the ephemeral fire-and-forget
  path, and carries a non-null `seq`

### Requirement: Rails persists and broadcasts `user_prompt` through the existing ingest path

Rails SHALL persist an ingested `user_prompt` event verbatim through `Events::Ingest`, keyed and deduped by
`(ai_run_id, seq)` like every other run-scoped durable event, and broadcast it on the session channel. Ingest
MUST NOT require new endpoint or schema changes, and `user_prompt` MUST NOT trigger any run-lifecycle state
transition.

#### Scenario: Ingested prompt is stored idempotently

- **WHEN** Rails ingests a `user_prompt` event for a run at a given `seq`
- **THEN** it is persisted as a durable event scoped to that `ai_run_id`/`seq` and broadcast to the session
- **AND** re-ingesting the same `(ai_run_id, seq)` is silently skipped (no duplicate, no error)

#### Scenario: It does not change run state

- **WHEN** a `user_prompt` event is ingested
- **THEN** the run's `status` is unchanged (it is not a lifecycle event; `Runs::Finalize` ignores it)

### Requirement: The web activity feed renders `user_prompt` inline, attributed, and distinct from Claude text

The web feed SHALL render `user_prompt` events inline in the durable event order (by `seq` within the run),
attributed to the originating participant, and visually distinct from Claude's `ai_text`. Rendering MUST read
only from the existing event store (no new fetch); a `user_prompt` whose participant name is unknown SHALL
still render its text with a generic attribution rather than being dropped.

#### Scenario: Prompt appears before Claude's reply

- **WHEN** the feed renders a run whose events are `user_prompt` (seq 1), `run_started` (seq 2), `ai_text`
- **THEN** the user's prompt text renders first, attributed to the participant, then the run banner, then
  Claude's reply — read top to bottom as a conversation

#### Scenario: Visually separable from Claude output

- **WHEN** a `user_prompt` and an `ai_text` are both present
- **THEN** the `user_prompt` is rendered by a dedicated user-prompt element (its own test id), distinct from
  the Claude text block

#### Scenario: Unknown event types remain safe

- **WHEN** a client that predates this change receives a `user_prompt` event
- **THEN** it does not crash — the feed routes the unrecognized durable type to its existing safe fallback

