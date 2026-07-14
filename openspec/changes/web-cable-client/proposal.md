## Why

Week 1 proved the server half of the live pipeline — the fake-Claude replay drives events through real
`Events::Ingest`, which persists durable events, skips ephemeral, and broadcasts every event over
`SessionChannel` at `/~cable`. But **no browser consumes that stream yet**: the `web/` scaffold is a static
shell with Zustand, TanStack Query, and `@rails/actioncable` installed-but-unwired. So a replay broadcasts
into the void.

This change closes the consumption half — the **missing piece of the Week-1 "replay end-to-end, watchable
from multiple browsers" milestone** (`docs/PLAN.md §10`). It is the lowest-risk, highest-payoff Week-2
starting point: it depends only on the **already-frozen** `event-envelope` and `http-api-contract`
capabilities (envelope shape + the gap-free catch-up algorithm), needs **nothing from the Tuesday SDK
spike** (it treats `payload` as opaque), and turns the dormant pipeline into something watchable at
`localhost:3000` in real time, across multiple browser tabs. It is the `cable.ts` + event-reducer work the
plan assigns to the frontend stream at the start of Week 2 (`docs/PLAN.md §10`, Manish 1.5d).

## What Changes

- **`web/src/lib/cable.ts`** — the single file owning the gap-free catch-up algorithm from
  `http-api-contract`: subscribe to the session channel FIRST → buffer live events → REST-backfill
  `GET /api/sessions/:id/events?after=<cursor>` → drain the buffer applying only durable events with
  `id > maxBackfilledId` while always applying ephemeral (null-`id`) events → go live. Built on an
  ActionCable provider (connection-state Context bridged to React) mounted at `/~cable`.
- **A Zustand event store** — the durable-vs-ephemeral two-tier reducer: durable events deduped by `id`;
  `ai_text_delta` accumulated by `(ai_run_id, block)` into in-progress text; `presence_changed` applied
  last-writer-wins per participant. Selectors keep the feed from re-rendering on every delta.
- **TanStack Query** wired for the REST backfill fetch (the one fetched resource this change needs).
- **The `app_provider` composition seam filled in** — the cable provider + Query client nested into the
  existing `AppProvider`, replacing the W1 "no store/query wired" stub.
- **Reducer + catch-up unit tests** (Vitest + the contract `sample_run.jsonl` fixture + MSW for the backfill
  REST call), per `docs/PLAN.md §13` ("2-3 vitest cases for the reducer").

This change does **not** render the rich activity feed (streamed-text/tool-chips/run-banner *rendering* is
`activity-feed-rendering`, and is spike-gated on real payload shapes); it does **not** add the prompt
composer, interrupt button, or chat (those are `prompt-composer-chat`); and it implements **no** run
orchestration or sidecar code. It delivers the **event-transport layer** the rendering work sits on top of —
proven by rendering the replay as a minimal raw list.

## Capabilities

### New Capabilities
- `web-event-transport`: The browser-side live event transport — the `cable.ts` gap-free catch-up algorithm
  (subscribe → buffer → backfill → drain → live) over an ActionCable provider at `/~cable`, the Zustand
  two-tier (durable/ephemeral) event store with dedupe-by-`id` and delta accumulation by `(ai_run_id, block)`,
  the TanStack Query backfill fetch, and the filled-in `app_provider` composition. Consumes the frozen
  `event-envelope` and `http-api-contract` capabilities; renders the replay as a minimal raw list to prove
  end-to-end delivery without depending on per-type payload shapes.

### Modified Capabilities
<!-- None — this consumes the frozen freeze-interface-contracts capabilities (event-envelope, http-api-contract) and fills in the web-scaffold's app_provider seam, but changes no existing spec's requirements. -->

## Impact

- **New code:** `web/src/lib/cable.ts` (catch-up algorithm), `web/src/lib/action_cable_provider.tsx`
  (connection-state Context), `web/src/stores/event_store.ts` (Zustand two-tier reducer),
  `web/src/hooks/use_session_events.ts` (subscribe + backfill orchestration), the TanStack Query client,
  the filled-in `web/src/providers/app_provider.tsx`, a minimal raw-list dev view proving delivery, and
  co-located `.test.ts(x)` reducer + catch-up tests.
- **Consumes (does not modify):** the frozen `event-envelope` (envelope shape, dual cursor, ephemeral null-`id`
  rule, dedupe-by-`id`, `(ai_run_id, block)` delta accumulation) and `http-api-contract` (the `/~cable`
  mount, the `clawd_uid` cookie authenticating cable, the `GET /api/sessions/:id/events?after=<cursor>`
  backfill endpoint and its ordered-array shape, the gap-free catch-up sequence).
- **Cross-stream:** unblocks `activity-feed-rendering` (which renders from this store) and is exercised
  end-to-end today by the existing `rails-foundation` fake-Claude replay broadcasting over `SessionChannel` —
  no sidecar or live Claude required.
- **Dependencies:** `freeze-interface-contracts` (frozen) and `rails-foundation` (the cable channel + backfill
  endpoint + cookie auth it connects to). No dependency on the SDK spike.
