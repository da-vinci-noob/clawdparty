## Context

This is the first Week-2 change and the browser-side half of the Week-1 "watchable" milestone. The server
side already works: `rails-foundation` ships `SessionChannel` at `/~cable` (broadcasting Contract-1
envelopes, participantship-verified), the `GET /api/sessions/:id/events?after=<cursor>` backfill endpoint
(ordered array, `id > cursor`), and cookie-authenticated cable (`ApplicationCable::Connection` resolves the
signed `clawd_uid` cookie). The `fake-claude-replay` rake broadcasts a real run through this path. The
`web/` scaffold has `zustand`, `@tanstack/react-query`, and `@rails/actioncable` installed but unwired, and
an `app_provider` composition seam explicitly left empty in W1.

The frozen contracts pin the hard parts: `http-api-contract` defines the **gap-free catch-up sequence**
(subscribe → buffer → backfill → drain `id > max` → live) and the **ephemeral exemption** (null-`id` events
bypass the drain filter and dedupe), and `event-envelope` defines the **dual cursor** (`id` global,
`seq` per-run), **dedupe-by-`id`** for durable events, and **`(ai_run_id, block)` delta accumulation**.
This change implements that algorithm in one file (`cable.ts`) plus a Zustand store — it does not invent
new transport behavior, it realizes the frozen one.

Crucially, this change is **spike-independent**: it treats `payload` as opaque JSON. It proves delivery by
rendering the stream as a minimal raw list, so it can ship today against the placeholder fixture and needs
no per-type payload shapes.

## Goals / Non-Goals

**Goals:**
- One file (`cable.ts`) owns the gap-free catch-up algorithm, exactly per `http-api-contract`.
- A Zustand store implementing the two-tier reducer: durable deduped by `id`; `ai_text_delta` accumulated
  by `(ai_run_id, block)`; `presence_changed` last-writer-wins per participant; ephemeral never deduped by `id`.
- An ActionCable provider exposing connection state to React, mounted at `/~cable`, authenticated by the
  existing `clawd_uid` cookie (no new auth).
- Fill the `app_provider` seam (cable provider + Query client) without changing W1's component structure.
- Prove end-to-end delivery by rendering the live replay as a raw list, multi-tab.
- Reducer + catch-up unit tests against the contract fixture + MSW, per `docs/PLAN.md §13`.

**Non-Goals:**
- Rich activity-feed rendering (streamed text, tool chips, run banners) — `activity-feed-rendering`,
  spike-gated on payload shapes.
- Prompt composer, follow-up, interrupt button, chat, presence UI — `prompt-composer-chat`.
- Run orchestration, sidecar, live Claude — later Week-2 changes.
- The join/auth flow that mints the `clawd_uid` cookie — this change assumes a cookie already exists
  (set by a manual join or seed); the join UI is `prompt-composer-chat`/W2. Tests inject the cookie/connection.

## Decisions

**1. `cable.ts` owns the catch-up sequence verbatim from `http-api-contract`; nothing else touches ordering.**
Subscribe to the channel FIRST and start buffering live events; THEN REST-backfill `after=<cursor>`; THEN
drain the buffer, applying durable (non-null `id`) events only when `id > maxBackfilledId`, while ALWAYS
applying ephemeral (null-`id`) events; THEN switch to live pass-through. *Why:* this is the one ordering that
is gap-free AND duplicate-free — subscribing first means no event is missed between backfill and live, and
the `id > max` filter drops the durable events backfill already returned. The ephemeral carve-out is
load-bearing: a null `id` is never `> max`, so a naive filter would wrongly drop deltas buffered during
catch-up. Putting this in one file matches `CLAUDE.md` ("the catch-up/cable logic lives in one file").

**2. Two-tier Zustand store keyed for selector stability.** Durable events live in an `id`-keyed structure
(dedupe-by-`id` is O(1) and idempotent across the backfill/live boundary). In-progress text is accumulated
separately by `(ai_run_id, block)` so a flood of `ai_text_delta` (10–20k/run per `docs/PLAN.md §14`) mutates
one string, not the durable log — and feed components subscribe via selectors so a delta re-renders only the
active text block, not the whole feed. `presence_changed` is a last-writer-wins map keyed by participant.
*Why:* the ephemeral-vs-durable split is a frozen contract decision precisely to keep the store and the
backfill small; the store mirrors it. *Alternative rejected:* one flat append-only list — deltas would bloat
it and every delta would re-render the feed.

**3. The durable cursor is `event.id`; nothing orders on `seq` or `ts`.** Backfill pages on `id`; the live
drain compares `id > maxBackfilledId`; dedupe is by `id`. `seq` is per-run and not a cross-run cursor; `ts`
is display-only. *Why:* directly from `event-envelope`'s dual-cursor rule — `id` is the single global cursor.

**4. Ephemeral events (null `id`) bypass backfill and dedupe entirely.** They are never returned by backfill
(never persisted), are applied immediately on arrival, are not stored in the durable `id`-map, and are not
deduped. `ai_text_delta` accumulates by `(ai_run_id, block)`; `presence_changed` is last-writer-wins. *Why:*
frozen `event-envelope` rule — null `id` marks ephemerality; deduping by a null `id` would collapse all
deltas into one. The `block` field's exact representation is `pending-spike`, so the store reads it as an
opaque key (W1 placeholder deltas may share one block; that is acceptable for the transport proof).

**5. ActionCable provider bridges connection state into React Context; the cookie authenticates it.** A thin
provider wraps `@rails/actioncable`'s `createConsumer("/~cable")`, exposing connect/disconnect/connection-state
to hooks. The signed `clawd_uid` cookie (httpOnly) is sent automatically by the browser on the WS handshake —
no token plumbing in JS. *Why:* `docs/PLAN.md §16` (cable provider, connection-state Context bridged to React)
and the frozen `http-api-contract` (same cookie authenticates REST and cable). *Test seam:* the consumer
factory is injectable so tests drive a fake channel without a real WS.

**6. Opaque-payload raw-list view proves delivery without the spike.** A minimal dev view renders the durable
log + in-progress text as plain text/JSON, so "the replay is watchable, multi-tab, catches up mid-run" is
demonstrable today. *Why:* decouples the transport milestone from the spike-gated rendering; the raw list is
replaced by `activity-feed-rendering` later. The store/`cable.ts` API is the stable seam between them.

**7. Tests use the contract fixture + MSW, not a live server.** Reducer tests feed `sample_run.jsonl` envelopes
through the store and assert dedupe/accumulation/last-writer-wins. The catch-up test drives the documented
sequence with a fake channel + an MSW-stubbed backfill response, asserting no gap and no duplicate across the
buffer→backfill→drain boundary (including an ephemeral event buffered mid-catch-up that must NOT be dropped).
*Why:* `docs/PLAN.md §13` scopes frontend testing to 2–3 reducer cases + the catch-up logic; browser E2E is
out. MSW `setupServer` is already wired by `web-test-harness`.

## Risks / Trade-offs

- **Catch-up off-by-one (gap or duplicate at the backfill/live seam).** The whole point of the algorithm.
  *Mitigation:* the dedicated catch-up test asserts both properties at the boundary, including the ephemeral
  carve-out; dedupe-by-`id` makes a duplicate harmless even if ordering slips.
- **Delta flood re-render jank.** 10–20k deltas/run. *Mitigation:* deltas mutate one `(ai_run_id, block)`
  string behind a selector; the durable log is untouched by deltas (Decision 2). Coalescing already happens
  server-side (~150ms in the sidecar) per the contract.
- **The `block` field is `pending-spike`.** Accumulation keys on a shape not yet finalized. *Mitigation:* the
  store treats `block` as an opaque key; W1 placeholder deltas collapsing into one block is acceptable for a
  transport proof and resolves when the spike lands the real field (additive, no store rewrite).
- **No join UI yet, so a real cookie must exist to see it live.** *Mitigation:* the seed/replay path plus a
  manually-set cookie suffice for the demo; tests inject the connection. The join flow is a later W2 change.
- **Reconnect/resubscribe mid-run.** A dropped WS must re-run catch-up (re-backfill from the last applied
  `id`). *Mitigation:* `cable.ts` re-runs the same subscribe→backfill→drain on reconnect using the store's max
  applied `id` as the cursor; dedupe-by-`id` makes the re-drain idempotent. Full reconnect-resync polish is
  W3, but the cursor-based re-entry is designed in here.

## Open Questions

- None blocking. The `block`-field representation is intentionally deferred to the spike (the store keys on it
  opaquely); everything else is pinned by the frozen contracts.
