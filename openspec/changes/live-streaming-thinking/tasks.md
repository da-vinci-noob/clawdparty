> **Additive (minor bump 1.2 → 1.3): one new ephemeral type, `ai_thinking_delta`.** Text streaming is
> contract-neutral (`ai_text_delta` exists). SDK shapes confirmed: `includePartialMessages: true` interleaves
> `SDKPartialAssistantMessage` (`type:"stream_event"`, `event: BetaRawMessageStreamEvent`); the delta we map is
> `content_block_delta` `{ index, delta:{type:"text_delta",text} | {type:"thinking_delta",thinking} }`; the
> partial `uuid` == the final assistant `uuid`, so block key `"<uuid>:<index>"` matches the durable block.
> Land contracts FIRST so both sides compile.

## 1. Contract (`packages/contracts`)

- [ ] 1.1 Add `"ai_thinking_delta"` to `EVENT_TYPES` (next to `ai_text_delta`) and to the ephemeral set; add `AiThinkingDeltaPayload { block: string; text: string }` + its `EventPayloadMap` entry
- [ ] 1.2 Bump `CONTRACT_VERSION` → `{ major: 1, minor: 3 }`; update `EVENT_TYPE_COUNT` guard `21 → 22`; fix the "21 names" prose
- [ ] 1.3 `tsc` + guards green (`PAYLOAD_MAP_COVERS_TAXONOMY`, count); `CHANGELOG.md [1.3.0]` + `events.md` ephemeral row + a note in `sdk_mapping.md` (`content_block_delta` → `ai_text_delta`/`ai_thinking_delta`; `includePartialMessages` + adaptive thinking)

## 2. Sidecar producer (`sidecar/`)

- [ ] 2.1 `buildOptions`: add `includePartialMessages: true` and `thinking: { type: "adaptive" }`
- [ ] 2.2 `normalizer.ts`: add `"ai_thinking_delta"` to `EPHEMERAL_TYPES`; add a `thinkingDelta(block, text)` method (mirrors `textDelta`)
- [ ] 2.3 `normalizer.map()`: handle `type: "stream_event"` — for `event.type === "content_block_delta"` emit `ai_text_delta` (`text_delta`) / `ai_thinking_delta` (`thinking_delta`) keyed `"<uuid>:<index>"`; return `[]` for all other stream-event subtypes (no `ai_raw`)
- [ ] 2.4 Confirm the runner drain ships these on the ephemeral path unchanged (deltas are ephemeral → `deliverEphemeral`); the terminal-break logic is unaffected (deltas aren't terminal)
- [ ] 2.5 Vitest: a scripted partial stream (init → text_delta×N → thinking_delta×N → content_block_stop → complete assistant → result) yields `ai_text_delta` + `ai_thinking_delta` with `block="<uuid>:<index>"`, ignores non-delta stream events, and still emits durable `ai_text`/`ai_thinking`/`run_finished`; Biome + tsc clean

## 3. Rails consumer (`api/`)

- [ ] 3.1 Add `ai_thinking_delta` to `Event::EPHEMERAL_TYPES` (ingest already broadcasts-not-persists ephemeral; no other change)
- [ ] 3.2 Spec: ingesting `ai_thinking_delta` broadcasts with null `id`/`seq`, creates no row, no run-state change; `ContractVersion` passes at `{1,3}`; `bin/rspec` (RAILS_ENV=test) + RuboCop green

## 4. Web consumer (`web/`)

- [ ] 4.1 `event_store.ts`: add a `thinkingByBlock` accumulator fed by `ai_thinking_delta` (mirror `textByBlock`); on a durable `ai_text` clear `textByBlock[block]` and on a durable `ai_thinking` clear `thinkingByBlock[block]` (no duplicate); optional safety sweep on a terminal run event
- [ ] 4.2 `feed/thinking_block.tsx`: a persistent, collapsible (default-expanded) thinking block; render the durable `ai_thinking` through it (replace the raw fallback) and the live `thinkingByBlock` stream into the same visual style
- [ ] 4.3 `activity_feed.tsx`: render live text (as today) + live thinking + `case "ai_thinking"` → `ThinkingBlock`
- [ ] 4.4 Vitest + RTL: text deltas then durable → rendered once; thinking deltas then durable → one persistent collapsible block; a delta flood doesn't grow the durable log; Biome + tsc clean

## 5. Validation

- [ ] 5.1 `openspec validate live-streaming-thinking --type change --strict` passes
- [ ] 5.2 All suites green: `api` (RSpec + RuboCop), `sidecar` (Biome + tsc + Vitest), `web` (Biome + tsc + Vitest)
- [ ] 5.3 Live smoke over Bedrock: start a run and watch text stream token-by-token; thinking streams into a collapsible block that persists after completion; confirm no duplicate block once settled and that a late-joining tab (backfill) sees the durable `ai_text`/`ai_thinking` (deltas are ephemeral, not backfilled)
