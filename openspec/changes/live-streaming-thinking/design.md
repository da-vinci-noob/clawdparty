## Context

Streaming was designed but never wired. The `web-cable-client` store already accumulates `ai_text_delta` by
`(ai_run_id, block)` into `textByBlock`; the feed renders that as a trailing `feed-streaming-text` block; the
sidecar `Normalizer` has an (unused) `textDelta(block, text)` method. What's missing is the producer: the
runner's `buildOptions` never sets `includePartialMessages`, so `@anthropic-ai/claude-agent-sdk` `query()`
yields only complete messages (`system`/`assistant`/`user`/`result`) and the user sees the whole reply at once.
Thinking is worse: `ai_thinking` (durable) renders through the generic `RawFallback`.

The SDK (confirmed against its `.d.ts`) supports `includePartialMessages: true`, which ADDITIVELY interleaves
`SDKPartialAssistantMessage` (`type: "stream_event"`) events carrying an Anthropic `BetaRawMessageStreamEvent`.
The one we need is `content_block_delta` with `{ index, delta }`, where `delta` is `{ type:"text_delta", text }`
or `{ type:"thinking_delta", thinking }`. The partial message's `uuid` equals the eventual `SDKAssistantMessage`
`uuid`, and `index` is the block position — so a delta keyed `"<uuid>:<index>"` matches the block key the
normalizer already emits for the durable `ai_text`/`ai_thinking` (`mapAssistant` uses `"<uuid>:<index>"`). That
alignment is what lets live deltas reconcile with the settled block.

## Goals / Non-Goals

**Goals:**
- Live text as Claude types; live thinking; a persistent, collapsible thinking block that stays.
- Reuse the existing delta accumulator + block-key convention so live→durable reconciliation is automatic.
- Minimal, additive contract change: exactly one new ephemeral type, `ai_thinking_delta`.
- No duplicate rendering: when the durable block settles, its live accumulator entry is dropped.

**Non-Goals:**
- Persisting deltas (they stay ephemeral — broadcast, null `id`/`seq` — like `ai_text_delta`).
- Streaming tool inputs (`input_json_delta`), citations, or redacted-thinking token UI.
- Aggressive coalescing beyond a simple per-block flush (ship deltas as they arrive for MVP).
- Any change to `ai_text_delta`, the envelope, run lifecycle, or the sidecar↔Rails protocol.

## Decisions

**1. `ai_thinking_delta` is a NEW ephemeral type; text reuses `ai_text_delta`.** Text streaming is
contract-neutral. Thinking has no delta type, so add `ai_thinking_delta` (ephemeral, payload `{ block, text }`
mirroring `ai_text_delta`). *Why a new type over a `kind` field on `ai_text_delta`:* the taxonomy already
splits durable `ai_text` vs `ai_thinking`; an ephemeral `ai_thinking_delta` parallels that exactly and keeps
each stream self-describing, so the reducer/feed switch on `type` (no payload sniffing). Additive `minor` bump
`1.2 → 1.3`; `EVENT_TYPE_COUNT` `21 → 22`; registered ephemeral in all three ephemeral sets.

**2. Block key `"<uuid>:<index>"` unifies live and durable.** The normalizer maps `content_block_delta` using
the partial message's `uuid` + `event.index`, producing the same key `mapAssistant` uses for the final block.
So a live block and its durable counterpart share a key, enabling both accumulation and clean supersession.

**3. Enable adaptive thinking in the sidecar.** `buildOptions` adds `thinking: { type: "adaptive" }` alongside
`includePartialMessages: true`. *Why:* without thinking enabled there are no `thinking_delta`s to stream. Both
flags are sidecar-local; the protocol payload is unchanged.

**4. The web clears the live accumulator when the durable block arrives.** The store, on applying a durable
`ai_text` (or `ai_thinking`), deletes `textByBlock`/`thinkingByBlock` for that `(ai_run_id, block)`. *Why:* the
feed renders durable blocks AND live accumulators; without clearing, a completed block would show twice (once
settled, once as a lingering live block). This is the reconciliation step block-key alignment makes trivial.

**5. Persistent collapsible thinking block.** A dedicated `feed/thinking_block.tsx` renders thinking:
collapsible, default-expanded, staying in the transcript. Live thinking streams into it (from
`thinkingByBlock`); the durable `ai_thinking` renders the settled block. Text keeps its existing live +
durable rendering.

## Risks / Trade-offs

- **Delta flooding the transport** (many ephemeral POSTs). → Deltas are per `content_block_delta` (already
  chunked by the API, not per-character); ephemeral delivery is fire-and-forget. A per-block coalesce is a
  later optimization, explicitly out of scope; noted so it isn't mistaken for "done."
- **Live/durable duplicate if keys don't align or clearing misfires.** → Decisions 2 + 4 + a store test that
  asserts a block shows once after its durable event arrives.
- **Model emits no thinking** (thinking disabled/omitted, or the model doesn't think for a prompt). → Then no
  `thinking_delta`s and no thinking block — text streaming is unaffected; the feature degrades cleanly.
- **`ai_thinking_delta` missed in one ephemeral set** → it would try to persist with a null `seq` (or dedupe
  oddly). → Add it to all three sets (contracts `EPHEMERAL`, sidecar `EPHEMERAL_TYPES`, Rails
  `Event::EPHEMERAL_TYPES`) in the same change; a Rails ingest spec asserts null `id`/`seq` + not persisted.
- **A stale web build receives `ai_thinking_delta`.** → Ephemeral + null id; the feed's fallback ignores
  unknown ephemeral types (they never enter the durable log), so an old client simply doesn't render it.

## Migration Plan

Additive. Order: (1) contracts (`ai_thinking_delta` + version bump + guard + docs) so both sides compile;
(2) sidecar (enable flags, map deltas, ephemeral set) + tests; (3) Rails (`Event` ephemeral set) + spec;
(4) web (accumulator, clearing, thinking block) + tests; (5) live verify over Bedrock. No data migration
(deltas are never persisted). Rollback = revert the edits; the `minor` bump reverts with them.

## Open Questions

- Thinking block default state: proposed **expanded** (so live streaming is visible), collapsible to hide.
  Finalized in implementation; trivial to flip.
- Whether to also clear the live accumulator on `run_finished` as a safety net (in case a durable block event
  is missed). Proposed: yes, a cheap belt-and-suspenders sweep of the run's live blocks on run end.
