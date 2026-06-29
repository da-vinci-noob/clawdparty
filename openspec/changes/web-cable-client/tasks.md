## 1. ActionCable provider + Query client

- [x] 1.1 Implement `web/src/lib/action_cable_provider.tsx`: wrap `@rails/actioncable` `createConsumer("/~cable")`, bridge connection state into a React Context; accept an injectable consumer factory so tests can supply a fake channel (no real WebSocket)
- [x] 1.2 Create the TanStack Query client (used for the REST backfill fetch) and a `use_session_events` query/hook seam
- [x] 1.3 Fill in `web/src/providers/app_provider.tsx`: nest the ActionCable provider + Query client at the existing composition seam, preserving the W1 error boundary / app shell / routes

## 2. Zustand two-tier event store

- [x] 2.1 Implement `web/src/stores/event_store.ts`: durable events keyed + deduped by global `id`; ephemeral events NOT stored in the durable map and NOT deduped by `id`
- [x] 2.2 Accumulate `ai_text_delta` into in-progress text keyed by `(ai_run_id, block)` (treat `block` as an opaque key — its representation is `pending-spike`); apply `presence_changed` last-writer-wins per participant
- [x] 2.3 Expose selectors so a delta flood mutates only the active `(ai_run_id, block)` text and does not re-render the durable log
- [x] 2.4 Track the maximum applied durable `id` in the store (the catch-up/reconnect cursor)

## 3. Gap-free catch-up in cable.ts

- [x] 3.1 Implement `web/src/lib/cable.ts` as the single owner of catch-up/ordering: subscribe to the session channel FIRST → buffer live events
- [x] 3.2 REST-backfill `GET /api/sessions/:id/events?after=<cursor>` (cursor = store max applied durable `id`, 0 on first join) via TanStack Query
- [x] 3.3 Drain the buffer: apply durable (non-null `id`) events only when `id > maxBackfilledId`; ALWAYS apply ephemeral (null-`id`) events; then transition to live pass-through
- [x] 3.4 On reconnect, re-run subscribe → backfill → drain from the store's max applied durable `id`; rely on dedupe-by-`id` to make the re-drain idempotent
- [x] 3.5 Order only on `id` (never `seq` or `ts`); confirm no bespoke cable message handling — every payload is a Contract-1 envelope

## 4. Minimal raw-list delivery proof (opaque payloads)

- [x] 4.1 Add a minimal raw-list view rendering the store's durable log + in-progress text as plain text/JSON (treat `payload` as opaque); wire it into the session route
- [~] 4.2 Manually verify against the live stack: run `fake_claude:replay` with a browser subscribed → durable events appear live; open a second tab mid-replay → it catches up to the same set  — *seam-verified: SPA serves via rails:3000, join→clawd_uid cookie→backfill returns the 17 events (ascending, concrete payloads) confirmed live; the two-tab human click-through is the one step only a browser can finish*
- [x] 4.3 Confirm ephemeral deltas render as accumulating text and are never deduped away

## 5. Tests (Vitest + RTL + MSW + contract fixture)

- [x] 5.1 Reducer unit test: feed `packages/contracts/fixtures/sample_run.jsonl` envelopes through the store; assert durable dedupe-by-`id`, `(ai_run_id, block)` delta accumulation, and `presence_changed` last-writer-wins
- [x] 5.2 Catch-up unit test: drive subscribe → buffer → (MSW-stubbed) backfill → drain with overlapping durable ids and assert no gap and no duplicate at the boundary
- [x] 5.3 Catch-up edge test: an ephemeral (null-`id`) event buffered during catch-up is applied, NOT dropped by the `id > max` filter
- [x] 5.4 Reconnect test: re-running catch-up from the max applied `id` re-applies overlapping durable events as no-ops (idempotent)
- [x] 5.5 Confirm `web` checks stay green: Biome + `tsc` + Vitest

## 6. Validation

- [x] 6.1 Run `openspec validate web-cable-client --type change --strict` and confirm valid
- [x] 6.2 Confirm the `web` CI job (Biome + tsc + Vitest, Node 24) is green with the new code
