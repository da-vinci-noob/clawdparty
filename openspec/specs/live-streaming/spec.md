# live-streaming Specification

## Purpose
TBD - created by archiving change live-streaming-thinking. Update Purpose after archive.
## Requirements
### Requirement: `ai_thinking_delta` is an ephemeral streaming type added additively

The contract SHALL add `ai_thinking_delta` as an **ephemeral** event type (broadcast, never persisted; null
`id` and null `seq`), payload `{ block: string, text: string }` mirroring `ai_text_delta`. The addition MUST be
additive: `CONTRACT_VERSION` bumps `minor` only (`{1,2}` → `{1,3}`), the taxonomy count guard goes `21 → 22`,
and a `CHANGELOG` entry records it. `ai_thinking_delta` MUST be registered ephemeral everywhere ephemerality is
decided (the contracts package, the sidecar normalizer, and Rails `Event`). `ai_text_delta` and every other
type are unchanged.

#### Scenario: The type is ephemeral across the stack

- **WHEN** the contract, sidecar, and Rails are built
- **THEN** `ai_thinking_delta` is in the taxonomy (count 22) with payload `{ block, text }`, and each
  layer classifies it ephemeral (carries null `id`/`seq`, never persisted)

#### Scenario: The version bump is additive

- **WHEN** the change ships
- **THEN** `CONTRACT_VERSION` is `{ major: 1, minor: 3 }` with a `CHANGELOG` entry, and a consumer requiring
  `major === 1` and `minor >= 1` still passes

### Requirement: The sidecar enables partial streaming and maps content-block deltas

The sidecar SHALL start runs with `includePartialMessages: true` and adaptive thinking enabled, and SHALL map
each `stream_event` whose `event.type` is `content_block_delta` to an ephemeral delta keyed
`"<uuid>:<index>"` (the partial message `uuid` + the block `index`): a `text_delta` → `ai_text_delta` (payload
`{ block, text }`) and a `thinking_delta` → `ai_thinking_delta` (payload `{ block, text }` from the thinking
chunk). Other stream events (`message_start`/`message_stop`/`content_block_start`/`content_block_stop`/
`message_delta`) SHALL be ignored (not emitted as `ai_raw`). The complete `assistant` and `result` messages
SHALL still be normalized to the durable `ai_text`/`ai_thinking`/`run_finished` exactly as before.

#### Scenario: Text deltas stream

- **WHEN** the SDK emits `content_block_delta` events with `text_delta` chunks for block index `i` of message
  `uuid`
- **THEN** the sidecar emits `ai_text_delta` events with `block = "<uuid>:<i>"` and the chunk text, on the
  ephemeral path

#### Scenario: Thinking deltas stream

- **WHEN** the SDK emits `content_block_delta` events with `thinking_delta` chunks for block index `t`
- **THEN** the sidecar emits `ai_thinking_delta` events with `block = "<uuid>:<t>"` and the thinking chunk, on
  the ephemeral path

#### Scenario: Non-delta stream events are ignored

- **WHEN** the SDK emits `message_start`, `content_block_start`, `content_block_stop`, `message_delta`, or
  `message_stop` stream events
- **THEN** the sidecar emits no envelope for them (no `ai_raw` noise)

#### Scenario: The durable block still arrives and shares the delta's key

- **WHEN** a streamed block completes and the final `assistant` message arrives
- **THEN** the sidecar emits the durable `ai_text` (or `ai_thinking`) with the SAME `block = "<uuid>:<index>"`
  key the deltas used

### Requirement: Rails broadcasts `ai_thinking_delta` without persisting it

`Events::Ingest` SHALL broadcast an `ai_thinking_delta` to the session channel with null `id` and null `seq`
and SHALL NOT persist it (identical handling to `ai_text_delta`). It SHALL NOT advance the per-run `seq` and
SHALL NOT trigger any run-state transition.

#### Scenario: Ephemeral broadcast, no row

- **WHEN** Rails ingests an `ai_thinking_delta`
- **THEN** it is broadcast with null `id`/`seq` and no Event row is created

### Requirement: The web streams text + thinking live and reconciles with the durable block

The web store SHALL accumulate `ai_text_delta` and `ai_thinking_delta` into live blocks keyed by
`(ai_run_id, block)` (text and thinking tracked separately). When the durable `ai_text` (or `ai_thinking`) for
a block arrives, the store SHALL clear that block's live accumulator so the settled block is NOT rendered
twice. The feed SHALL render live text (as today), live thinking, and a **persistent, collapsible** thinking
block for the durable `ai_thinking`.

#### Scenario: Live text then settled — shown once

- **WHEN** `ai_text_delta`s accumulate a block and then its durable `ai_text` arrives
- **THEN** the feed shows the streaming text live, and after the durable event the block is rendered exactly
  once (the live accumulator for that block is cleared)

#### Scenario: Live thinking then settled — shown once, persistent + collapsible

- **WHEN** `ai_thinking_delta`s accumulate a thinking block and then its durable `ai_thinking` arrives
- **THEN** the thinking streams live into a thinking block, and after settling it remains as a persistent,
  collapsible thinking block rendered exactly once

#### Scenario: A delta flood does not grow the durable log

- **WHEN** many `ai_thinking_delta` / `ai_text_delta` events arrive
- **THEN** they accumulate into the live blocks only and the durable event log does not grow (ephemeral, null
  id, never persisted)

