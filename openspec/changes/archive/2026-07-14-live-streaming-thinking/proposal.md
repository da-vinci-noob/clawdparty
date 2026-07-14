## Why

The activity feed shows Claude's reply only **after the whole response completes** — no live typing, no visible
thinking. The streaming machinery was half-built: the store accumulates `ai_text_delta` into a trailing live
block, the feed renders it (`feed-streaming-text`), and the normalizer has a `textDelta()` method — but the
runner never sets `includePartialMessages`, so `query()` only ever yields **complete** messages. `textDelta()`
is dead code, no deltas are emitted, and `ai_thinking` renders through the generic raw fallback ("no rich UI
yet"). This change turns on real streaming: live text as Claude types, live thinking, and a persistent
collapsible thinking block.

## What Changes

- **Sidecar enables partial streaming** — `buildOptions` sets `includePartialMessages: true` and
  `thinking: { type: "adaptive" }`. The runner now also receives `SDKPartialAssistantMessage` (`type:
  "stream_event"`) events interleaved with the existing complete messages (additive — the complete
  `assistant`/`result` messages still arrive unchanged).
- **The normalizer maps stream deltas** — a `stream_event` carrying `event.type: "content_block_delta"` maps to
  an ephemeral delta keyed `"<uuid>:<index>"` (the SDK's partial `uuid` equals the eventual assistant message
  `uuid`, so the delta's block key **matches** the durable `ai_text`/`ai_thinking` block key at block-stop):
  - `delta.type: "text_delta"` (`delta.text`) → **`ai_text_delta`** (existing type — contract-neutral).
  - `delta.type: "thinking_delta"` (`delta.thinking`) → **`ai_thinking_delta`** — a NEW ephemeral type (the
    only contract addition; there is no thinking-delta today).
  - Non-delta stream events (`message_start`/`stop`, `content_block_start`/`stop`, `message_delta`) are
    ignored (not `ai_raw` noise).
- **New `ai_thinking_delta` event type** (the 22nd taxonomy name) — **ephemeral** (broadcast-not-persisted,
  null `id`/`seq`), payload `{ block, text }` mirroring `ai_text_delta`. Additive `CONTRACT_VERSION` bump
  `1.2 → 1.3` + `CHANGELOG` entry; `EVENT_TYPE_COUNT` guard `21 → 22`. Registered ephemeral in all three
  ephemeral sets (contracts, sidecar normalizer, Rails `Event`).
- **Rails** treats `ai_thinking_delta` as ephemeral: `Events::Ingest` broadcasts it (null `id`/`seq`) and never
  persists it — no new code beyond adding it to the ephemeral set + the contract version.
- **Web** — a live thinking accumulator (parallel to the text one) keyed by `(ai_run_id, block)`; a **persistent
  collapsible thinking block** (`ai_thinking_delta` renders it while streaming(the durable `ai_thinking` keeps
  it after). Critically, when the durable `ai_text`/`ai_thinking` for a block arrives, its **live accumulator
  entry is cleared** so the settled block is not shown twice.

This does **not** change any existing event's shape, the envelope, the run lifecycle, or the sidecar↔Rails
protocol; text streaming is contract-neutral and only `ai_thinking_delta` is added (additively).

## Capabilities

### New Capabilities
- `live-streaming`: end-to-end live streaming of Claude output — the sidecar enabling `includePartialMessages`
  + adaptive thinking and mapping `content_block_delta` to ephemeral `ai_text_delta` / `ai_thinking_delta`
  (keyed `<uuid>:<index>`); the new ephemeral `ai_thinking_delta` type + its ephemeral treatment in Rails; and
  the web rendering of live text + live/persistent-collapsible thinking, with the live accumulator cleared
  when the durable block settles.

### Modified Capabilities
<!-- None as OpenSpec deltas: the consumed capabilities (event-envelope / contracts-package from
     freeze-interface-contracts, sidecar-runner, web-cable-client's store, activity-feed-rendering) are not
     archived into openspec/specs/. This ADDS one ephemeral taxonomy name (additive minor bump per the
     contract's own rule) and finishes the intended-but-unwired streaming path; `ai_text_delta`, the envelope,
     scalar types, and all endpoint/protocol signatures are unchanged. -->

## Impact

- **Contracts** (`packages/contracts/src/events.ts`): `+ai_thinking_delta` in `EVENT_TYPES` + `EPHEMERAL`,
  `AiThinkingDeltaPayload { block, text }` + `EventPayloadMap` entry, `EVENT_TYPE_COUNT` `21 → 22`,
  `CONTRACT_VERSION` `{1,3}`. Docs: `events.md` (new ephemeral row), `CHANGELOG.md` (`[1.3.0]`), a note in
  `sdk_mapping.md` (`content_block_delta` → deltas; `includePartialMessages`).
- **Sidecar** (`buildOptions`, `normalizer.ts`): enable partial streaming + adaptive thinking; add a
  `stream_event`/`content_block_delta` mapping and a `thinkingDelta()` method; add `ai_thinking_delta` to
  `EPHEMERAL_TYPES`. Vitest: a scripted partial stream emits `ai_text_delta` + `ai_thinking_delta` with the
  right block keys; non-delta stream events are ignored; the final durable `ai_text`/`ai_thinking` still arrive.
- **Rails** (`api/app/models/event.rb`): add `ai_thinking_delta` to `EPHEMERAL_TYPES` (ingest already
  broadcasts-not-persists ephemeral). Spec: an ingested `ai_thinking_delta` broadcasts with null `id`/`seq`
  and is not persisted; `ContractVersion` stays compatible at `{1,3}`.
- **Web** (`stores/event_store.ts`, `components/activity_feed.tsx`, new `feed/thinking_block.tsx`): a
  `thinkingByBlock` accumulator; clear `textByBlock`/`thinkingByBlock` for a block when its durable
  `ai_text`/`ai_thinking` arrives; render live text (as today) + live thinking + a persistent collapsible
  thinking block. Vitest + RTL for accumulation, no-duplicate, and the collapsible block.
- **Contract-neutral for text**; the single additive change is `ai_thinking_delta`. The Rails
  `ContractVersion` consumer (exact major, `minor >=`) tolerates `1.3` — the same mechanism proven at
  `1.0→1.1→1.2`.
- **Out of scope:** persisting thinking deltas (they stay ephemeral like text deltas); tool-input streaming
  (`input_json_delta`); redacted-thinking token-count UI; coalescing tuning beyond a simple per-block flush.
