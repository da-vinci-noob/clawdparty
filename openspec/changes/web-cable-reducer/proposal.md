## Why

The `web-scaffold` shell renders routes but consumes the frozen contract only as a type — there is
no live data path. Week 2 needs the browser to receive events and hold them as coherent session
state before any feature (activity feed, prompt/interrupt, chat) can render. This change builds that
foundation: the single cable client + event store that everything else reads from. It can be built
and verified end-to-end today against the `fake-claude-replay` path (already broadcasting real
envelopes through real ingest), with no dependency on the live sidecar run loop.

## What Changes

- Add `web/src/lib/cable.ts` — the one file that owns the ActionCable connection, session-channel
  subscription, and the gap-free late-joiner catch-up algorithm (subscribe → buffer → backfill →
  drain → live) exactly as pinned in `http-api-contract` §6.
- Add a Zustand event store that applies Contract-1 envelopes into session state: dedupe **durable**
  events by `id`, accumulate `ai_text_delta` by `(ai_run_id, block)`, apply `ai_text` as the durable
  record on block stop, treat `presence_changed` as last-writer-wins per participant.
- Add the TanStack Query client and wire the cable-connection context + store providers into the
  existing `AppProvider` composition seam (replacing the W1 placeholder).
- Add a REST helper for event backfill (`GET /api/sessions/:id/events?after=<cursor>`) returning
  ordered envelopes, and a connection-state context bridged from ActionCable to React.
- Replace the `SessionEventLog` placeholder in `helpers/contract_types.ts` with the real store state.

## Capabilities

### New Capabilities
- `web-cable-client`: ActionCable connection lifecycle mounted at `/~cable`, session-channel
  subscription (server independently verifies participantship), and the buffer/backfill/drain
  catch-up + reconnect resync driven solely by the envelope `id` cursor.
- `web-event-store`: the Zustand reducer that turns a stream of envelopes into session state —
  durable dedupe by `id`, delta accumulation by `(ai_run_id, block)`, ephemeral handling
  (null-`id` events exempt from dedupe; presence last-writer-wins), ordering by `id`/`seq` never `ts`.

### Modified Capabilities
<!-- None. This change consumes the frozen event-envelope and http-api-contract capabilities and
     extends web-app-shell's provider seam without changing its requirements. -->

## Impact

- **Code (web/ only):** new `web/src/lib/cable.ts`, `web/src/stores/*` (event store), `web/src/hooks/*`
  (store/connection selectors), `web/src/helpers/*` (backfill fetch), updated
  `web/src/providers/app_provider.tsx` and `web/src/helpers/contract_types.ts`.
- **Dependencies:** activates already-declared `@rails/actioncable`, `zustand`, `@tanstack/react-query`
  (present since `web-scaffold`; no new packages).
- **Consumes (unchanged):** `event-envelope` (envelope shape, cursor & ephemerality rules) and
  `http-api-contract` (cable mount, backfill endpoint, catch-up algorithm). No contract change.
- **Enables:** `web-activity-feed` and `web-prompt-interrupt-chat` render off this store.
- **Out of scope:** activity-feed rendering, prompt/interrupt/chat UI, file/diff APIs, and the live
  sidecar run loop. This change is verified against `fake-claude-replay`; live-run integration is a
  later track. No Rails or sidecar code changes here.
