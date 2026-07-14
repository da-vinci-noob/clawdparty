## Context

The center pane of the app shell (`docs/PLAN.md §6`) is where Claude's work is watched. `web-cable-client`
provides the data: a Zustand store with the durable event log keyed by `id`, in-progress text accumulated by
`(ai_run_id, block)`, a presence map, and selectors that isolate delta churn. This change renders that store —
it is pure read-side UI, no new transport or events.

It is SDK-spike-gated by nature: a `tool_started` chip shows the summarized tool input, a `terminal_output`
block shows chunked Bash output, a `run_finished` banner shows cost/usage — all per-type `payload` fields that
`sdk-message-spike` finalizes. The frozen `event-envelope` gives the envelope-level facts this change relies on
regardless of the spike: the actor union (for attributing banners/text to a participant resolved via the
participants list), and the ephemeral-vs-durable split (streamed text vs the durable `ai_text` record).

## Goals / Non-Goals

**Goals:**
- Streamed text: render the live-accumulating `(ai_run_id, block)` text (typing effect) and resolve to the
  durable `ai_text` bubble on block stop.
- Collapsible tool chips from `tool_started`/`tool_finished`/`tool_failed` showing the summarized input,
  expandable to detail; `terminal_output` rendered legibly with `anser` ANSI coloring, scroll-capped.
- Run banners from the lifecycle events, participant-attributed (resolve `actor.id` → display name).
- `file_changed` rows (compact; full diff is the W3 review screen).
- A capped/selector-driven feed that survives a 10–20k-delta run without re-rendering everything.
- Component tests rendering the real `sample_run.jsonl` and asserting text/chip/banner output.

**Non-Goals:**
- Any store/transport change — consumes `web-cable-client` as-is.
- Prompt composer, follow-up, interrupt button, chat panel, presence UI — `prompt-composer-chat`.
- The diff viewer / approval screen — W3.
- New event types or payload changes — rendering only.

## Decisions

**1. Per-type renderers behind one feed component, switching on `event.type`.** `activity_feed.tsx` maps the
store's ordered durable log to per-type renderers (`text_block`, `tool_chip`, `terminal_block`, `run_banner`,
`file_changed_row`), with the in-progress `(ai_run_id, block)` text rendered as a live trailing block. *Why:*
mirrors the frozen taxonomy; an unknown/`ai_raw` type renders a safe fallback (raw collapsible), so a
not-yet-rendered type never breaks the feed. *Consistency with the contract:* the renderer switch is the UI
twin of the normalizer's mapping — both keyed on the 20 names + `ai_raw`.

**2. Streamed text reads the ephemeral channel; the durable bubble is the record.** While a block streams, the
feed shows the accumulating `(ai_run_id, block)` text from the store's ephemeral side (selector-isolated so only
that block re-renders); on block stop the durable `ai_text` event becomes the persisted bubble. *Why:* matches
the frozen ephemeral-vs-durable rule and `web-cable-client`'s store shape; keeps the delta flood off the durable
log and off the rest of the feed.

**3. Tool chips show the summarized input only; never the full payload.** The chip renders the spike-finalized
summarized `tool_started` input (path/command/~500 chars); expanding shows `tool_finished`/`tool_failed` detail.
*Why:* the full Edit/Write payload is deliberately not in the event (spike schema / `docs/PLAN.md`), so the chip
cannot and must not try to render it; the full change is reviewed in the W3 diff screen.

**4. `terminal_output` uses `anser` and is scroll-capped.** Bash output (chunked ~64KB by the normalizer) renders
through `anser` for ANSI→HTML and is capped to a scrollable height. *Why:* `anser` is an already-installed dep
chosen for exactly this; uncapped terminal output would blow out the feed.

**5. Attribution resolves `actor.id` → display name client-side.** Banners and text attributed to a human read
`actor.id` (a participant id) and resolve the name from the participants list, per the frozen `event-envelope`
(actor carries the id, not the name; names resolved client-side). Claude/system events show "Claude"/system
framing. *Why:* the contract deliberately keeps names out of events.

**6. The feed is capped + selector-driven for delta resilience.** Components subscribe via Zustand selectors so
a delta mutates only the active text block; the rendered durable set is capped/windowed (`docs/PLAN.md §14`
capped feed) so a long run doesn't render thousands of nodes at once. *Why:* streaming UX jank is a named top
risk; the two-tier store + selectors + a cap are the mitigation.

**7. Tests render the real `sample_run.jsonl`; this is why the change is sequenced after the spike.** Component
tests feed the post-spike `sample_run.jsonl` through the store and assert the feed shows the expected text,
chips (with summarized input), terminal block, and banners. *Why:* `docs/PLAN.md §13` scopes frontend tests
tightly; rendering the executable contract fixture is the highest-value check and only meaningful once payloads
are real.

## Risks / Trade-offs

- **Spike-gated: per-type renderers need real payload shapes.** *Mitigation:* sequenced after `sdk-message-spike`;
  the `ai_raw`/unknown fallback means a missing renderer degrades gracefully rather than crashing; streamed text
  (least payload-coupled) can be built first.
- **Delta-flood re-render jank.** *Mitigation:* selector isolation + capped feed (Decision 6); coalescing already
  happens server-side.
- **Terminal output size.** *Mitigation:* normalizer chunks to ~64KB; the feed scroll-caps and lazy-renders.
- **Attribution gaps (participant id not yet in the local list).** *Mitigation:* fall back to a short id/placeholder
  until the participants list resolves; never block rendering on name resolution.
- **Tool chip tempted to show full input.** *Mitigation:* the event simply doesn't carry it; the chip renders the
  summary and links to the W3 diff screen for the real change.

## Open Questions

- Exact visual design (chip layout, banner styling) is implementation detail, not contract; the renderers key on
  the frozen taxonomy + spike payload fields, which is what matters for correctness.
