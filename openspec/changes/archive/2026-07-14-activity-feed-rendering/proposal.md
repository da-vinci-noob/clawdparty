## Why

`web-cable-client` delivers the live event stream into the browser and proves it with a raw-list view — but a
raw JSON list is not a usable activity feed. The Week-2 milestone is that Claude's work is **watchable**:
streamed text appears as it's generated, tool calls render as readable chips, terminal output is legible, and
run lifecycle is framed by banners. That rich rendering is the frontend's core Week-2 deliverable
(`docs/PLAN.md §10`, Manish: "activity feed real rendering — streamed text, collapsible tool chips, run
banners").

This change renders the `web-cable-client` Zustand store into the center-pane activity feed. It is
**SDK-spike-gated**: tool chips, terminal output, and run banners read per-type `payload` fields, which only
become real once `sdk-message-spike` finalizes the schemas. (Streamed text rides the ephemeral
`ai_text_delta`/durable `ai_text` mechanism the cable client already exposes, so the text-streaming part is
less payload-dependent — but tool/terminal/file rendering needs the real shapes.) It depends on
`web-cable-client` (the store + selectors) and consumes `sdk-message-spike` (the payload schemas + the real
`sample_run.jsonl` to render in tests), so it SHOULD be applied after both.

## What Changes

- **Streamed-text rendering** — the in-progress `(ai_run_id, block)` text accumulates live (typing effect) and
  resolves to the durable `ai_text` block on stop, rendered as Claude's message bubbles in the feed.
- **Collapsible tool chips** — `tool_started`/`tool_finished`/`tool_failed` render as compact, collapsible chips
  showing the summarized tool input (path/command, never the full Edit/Write payload, per the spike schema),
  expandable to the finish/fail detail. `terminal_output` (the ~64KB Bash chunks) renders in a legible,
  scroll-capped block using `anser` for ANSI color (already an installed dep).
- **Run banners** — `run_started`/`run_finished`/`run_failed`/`run_interrupted`/`changeset_ready` render as
  feed banners framing a run, attributed to the acting participant (resolved from `actor.id` via the
  participants list) for human-originated events.
- **`file_changed` rows** — a compact per-file indicator in the feed (the full diff lives behind the diff API /
  W3 review screen, not inline here).
- **A capped, virtualization-friendly feed** — selectors keep a delta flood (10–20k/run) from re-rendering the
  whole feed; the feed caps/window the rendered set per `docs/PLAN.md §14` (capped feed).
- **Vitest + RTL component tests** rendering the real `sample_run.jsonl` (post-spike) into the feed and
  asserting text/chip/banner output.

This change renders only; it adds **no** new events, **no** store/transport changes (it consumes the
`web-cable-client` store), **no** prompt composer / interrupt button / chat (`prompt-composer-chat`), and
**no** diff viewer (W3). It is the read-only activity feed.

## Capabilities

### New Capabilities
- `activity-feed`: the center-pane rendering of the `web-cable-client` event store — streamed text (live
  accumulation → durable bubble), collapsible tool chips (summarized input + ANSI terminal output), run
  lifecycle banners (participant-attributed), `file_changed` rows, and a capped/selector-driven feed that
  survives a delta flood. Read-only; consumes the store and the spike-finalized payload schemas.

### Modified Capabilities
<!-- None as OpenSpec deltas: web-cable-client is not archived into openspec/specs/. This ADDS rendering on top
     of that change's store; it changes none of its requirements. -->

## Impact

- **New code:** `web/src/components/activity_feed.tsx` and per-type renderers (e.g.
  `web/src/components/feed/text_block.tsx`, `tool_chip.tsx`, `terminal_block.tsx`, `run_banner.tsx`,
  `file_changed_row.tsx`), feed selectors/hooks reading the store, participant-name resolution helper, and
  co-located `.test.tsx` tests. Replaces the `web-cable-client` raw-list view in the session route.
- **Consumes (does not modify):** the `web-cable-client` store (durable log keyed by `id`, in-progress text by
  `(ai_run_id, block)`, presence map, selectors), the frozen `event-envelope` (actor union for attribution,
  ephemeral-vs-durable), and `sdk-message-spike` (per-type payload schemas + the real `sample_run.jsonl` used in
  tests). Uses already-installed `anser` (ANSI) and React.
- **SDK-spike-gated:** tool chips, terminal output, run banners, and `file_changed` rows read per-type payload
  fields, so this change SHOULD be applied after `sdk-message-spike`. Streamed text is the least payload-coupled
  part. The feed structure can be built against the placeholder, but the per-type renderers need real shapes to
  render anything beyond opaque blobs.
- **Cross-stream:** completes the "watchable" half of the W2 milestone with `web-cable-client` (transport) and
  `sidecar-runner`/`run-orchestration` (producing real runs). Pairs with `prompt-composer-chat` for the
  interactive half (composer/interrupt/chat).
- **Dependencies:** `web-cable-client` (store), `sdk-message-spike` (payload schemas), `freeze-interface-contracts`.
