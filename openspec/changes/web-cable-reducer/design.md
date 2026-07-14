## Context

`web-scaffold` left `AppProvider` as an empty composition seam and `contract_types.ts` importing the
envelope as a type only. This change adds the live data path: one cable client and one event store
that all Week-2 features read from. The behaviour is fully pinned by frozen capabilities —
`event-envelope` (cursor/ephemerality rules) and `http-api-contract` §3/§6 (cable mount, backfill
endpoint, catch-up algorithm) — so this is an implementation of an agreed contract, not new protocol.

It is buildable and verifiable today: `fake-claude-replay` already pushes real Contract-1 envelopes
through real ingest → cable broadcast, so the client + store get exercised end-to-end without the
live sidecar run loop.

## Goals / Non-Goals

**Goals:**
- A single `web/src/lib/cable.ts` owning connection, subscription, and gap-free catch-up (CLAUDE.md:
  "the catch-up/cable logic lives in one file").
- A Zustand store that reduces a stream of envelopes into correct session state under out-of-order
  delivery, reconnects, and late joins.
- Wire TanStack Query client + cable connection context + store into `AppProvider`.
- Verified against `fake-claude-replay` with Vitest + RTL + MSW.

**Non-Goals:**
- Rendering (activity feed, chat, composer) — later tracks read this store.
- File/diff APIs, prompt/interrupt/chat endpoints, live sidecar run loop.
- No Rails or sidecar changes; no contract changes.

## Decisions

**1. `cable.ts` is the sole owner of connection + catch-up.** It exposes an imperative controller
(connect, subscribe(sessionId), disconnect) plus a connection-state observable bridged to React via a
context. Rationale: the buffer/backfill/drain ordering is a single stateful sequence; splitting it
across hooks reintroduces the gap the algorithm exists to prevent. Alternative (react-query
subscription hook) rejected — it hides the subscribe-*before*-backfill ordering that correctness
depends on.

**2. Catch-up is imperative and cursor-only** (`http-api-contract` §6): subscribe first → buffer live
envelopes → `GET /api/sessions/:id/events?after=<cursor>` (200, ordered ascending `id`) → drain the
buffer applying **durable** events only when `id > maxBackfilledId` while **always** applying
ephemeral (null-`id`) events → go live. The initial cursor is `0` (or the last-applied durable `id`
on reconnect resync). Ordering is by `id`/`seq`, never `ts`.

**3. Backfill uses a plain fetch helper, not a TanStack Query resource.** It is a one-shot step inside
the imperative catch-up, not a cache-managed view. TanStack Query is reserved for fetched *resources*
(session, participants) in later tracks; its client is still installed here so those tracks have the
provider ready.

**4. Store shape (Zustand), reducing by envelope `type`:**
- `eventsById: Map<number, EventEnvelope>` — durable events, **deduped by `id`** (the same durable
  event can arrive from both live cable and backfill; apply once).
- `textBlocks: Map<string, string>` keyed by `(ai_run_id, block)` — `ai_text_delta` appends;
  `ai_text` writes the durable record on block stop. Deltas never consume `seq` and are never persisted.
- `presenceByParticipant: Map<string, PresencePayload>` — `presence_changed` is last-writer-wins.
- `runsById` — run lifecycle derived from `run_started`/`run_finished`/`run_failed`/`run_interrupted`.
Rationale: mirrors the three durability/scope axes the envelope already defines; the reducer is a pure
switch on the 20 types + `ai_raw` passthrough.

**5. Reconnect = resync, not replay-from-zero.** On cable drop→reopen, re-run the catch-up sequence
with `after=<maxBackfilledId>`; dedupe-by-`id` makes any overlap a no-op. Presence is re-established by
whatever `presence_changed` events arrive after resubscribe.

**6. No hardcoded host.** The cable consumer targets `/~cable` and backfill targets `/api/...` as
same-origin relative paths (the browser only ever talks to Rails); auth is the shared `clawd_uid`
cookie sent automatically. This keeps the cross-machine LAN smoke a config concern, not a code change.

## Risks / Trade-offs

- [The classic ephemeral-drop bug: a naive `id > max` drain filter silently drops null-`id` ephemeral
  events buffered during catch-up] → the drain rule is explicit — durable filtered by `id > max`,
  ephemeral **always applied**; covered by a dedicated replay test.
- [Delta accumulation needs a per-block identifier in the `ai_text_delta` payload; the exact payload
  field is spike-gated in `event-envelope`] → the `(ai_run_id, block)` keying is fixed by contract;
  the concrete payload field name is read from the finalized envelope payload — do not invent it here.
  If unavailable at build time, key on the block index the normalizer emits and adjust when payloads land.
- [Cross-machine cable auth (the Week-2 landmine): works on localhost, silently 403s/drops from a
  second laptop] → mitigated on the web side by same-origin relative paths + cookie auth (above); the
  actual origins/allowed-hosts fix lives in Rails/config and is smoke-tested end of Week 2.
- [Out-of-order or duplicate live delivery during the buffer window] → dedupe-by-`id` for durable +
  last-writer-wins presence + `(ai_run_id, block)` delta keys make the reducer idempotent by design.

## Migration Plan

Additive within `web/`; no data migration. Rollback = revert the branch (the scaffold still builds).
Verified via `fake-claude-replay` before any live-run integration depends on it.

## Open Questions

- Concrete `ai_text_delta` payload field used as the block key — resolved by the finalized
  `event-envelope` per-type payloads; see the Risks dependency above.
