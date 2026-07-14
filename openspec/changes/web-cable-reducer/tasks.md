## 1. Providers and backfill helper

- [ ] 1.1 Add a TanStack Query client and `QueryClientProvider` into `web/src/providers/app_provider.tsx` (replace the W1 placeholder comment; keep `ErrorBoundary` outermost)
- [ ] 1.2 Add `web/src/helpers/backfill.ts` — a **page-aware** fetch loop for `GET /api/sessions/:id/events?after=<cursor>`: advance the cursor to each page's max `id` and re-fetch until a short/empty page, returning ordered `EventEnvelope[]`; same-origin relative path, credentials included; parse `{ errors }` on non-2xx. (Server is single-array until change #9; the loop is a no-op extra fetch until then — write it page-aware now.)
- [ ] 1.3 Replace the `SessionEventLog` placeholder in `web/src/helpers/contract_types.ts` with the real store state type

## 2. Event store (web-event-store)

- [ ] 2.1 Add `web/src/stores/session_store.ts` (Zustand): `eventsById` (durable, deduped by `id`), `textBlocks` keyed by `(ai_run_id, block)`, `presenceByParticipant`, `runsById`
- [ ] 2.2 Implement the reducer as a switch over the 20 types + `ai_raw` passthrough; retain unknown/`ai_raw` without throwing
- [ ] 2.3 Durable dedupe by `id` (re-apply of same `id` is a no-op); order by `id`/`seq`, never `ts`
- [ ] 2.4 `ai_text_delta` accumulation by `(ai_run_id, block)`; `ai_text` writes the block's durable final text; deltas never consume `seq`. **DEPENDS ON `finalize-sdk-event-contract` (change #1):** the concrete `block` payload field is spike-gated in `event-envelope` — do not start 2.4 until #1 lands the field. The rest of group 2 (dedupe, presence, lifecycle) is payload-independent and can proceed.
- [ ] 2.5 `presence_changed` last-writer-wins per participant; ephemeral (null-`id`) events exempt from dedupe
- [ ] 2.6 Derive run lifecycle from `run_started`/`run_finished`/`run_failed`/`run_interrupted`
- [ ] 2.7 Add `web/src/hooks/` selectors for store slices (events, in-progress text, presence, run state)

## 3. Cable client + catch-up (web-cable-client)

- [ ] 3.1 Add `web/src/lib/cable.ts` — single owner of the `/~cable` connection and session-channel subscription; targets are same-origin relative paths, cookie-authed; no hardcoded host
- [ ] 3.2 Implement the catch-up sequence: subscribe → buffer live → page-aware backfill (helper 1.2, fetch until short page) → drain → live
- [ ] 3.3 Drain rule: apply durable events only when `id > maxBackfilledId`; ALWAYS apply ephemeral (null-`id`) events
- [ ] 3.4 Reconnect resync: on reopen, resubscribe and re-run catch-up with `after=<max applied durable id>` (overlap is a dedupe no-op)
- [ ] 3.5 Expose connection state (connecting/connected/disconnected) via a React context bridged from ActionCable; wire the context + store into `AppProvider`
- [ ] 3.6 Handle rejected subscription (non-participant) → disconnected/unauthorized state, no crash

## 4. Tests (Vitest + RTL + MSW, verified against fake-claude-replay)

- [ ] 4.1 Store unit tests: durable dedupe-by-`id`; delta accumulation + `ai_text` finalize (no `seq` consumed); presence last-writer-wins; `ai_raw`/unknown retained
- [ ] 4.2 Catch-up test: late joiner merges backfill + buffered live with no gap and no duplicate
- [ ] 4.3 Ephemeral-drop regression test: null-`id` events buffered during catch-up are applied, not dropped
- [ ] 4.4 Backfill-failure test: non-2xx `{ errors }` retries without dropping buffered events or going live with a gap
- [ ] 4.5 Reconnect resync test: drop→reopen backfills from last applied `id`; overlap leaves state unchanged
- [ ] 4.6 Drive the store/cable end-to-end against the `sample_run.jsonl` fixture (the fake-claude-replay stream) and assert final session state

## 5. Gate

- [ ] 5.1 `cd web && npx biome check . && npx tsc --noEmit && npx vitest run` all green (Node 24 pin in CI)
- [ ] 5.2 Confirm no new dependencies added (activate existing `@rails/actioncable`, `zustand`, `@tanstack/react-query`); no Rails/sidecar/contract changes
