> **Depends on `web-cable-client` (store) and is SDK-spike-gated** (`sdk-message-spike` payload schemas + real
> `sample_run.jsonl`). Streamed text (§1) is the least payload-coupled; tool/terminal/banner renderers (§2–§4)
> need the real payload fields. Apply after both.

## 1. Streamed text (activity-feed)

- [x] 1.1 `web/src/components/feed/text_block.tsx`: render the live in-progress `(ai_run_id, block)` text from the store (selector-isolated), resolving to the durable `ai_text` bubble on block stop
- [x] 1.2 Confirm a delta flood re-renders only the active block (selector isolation), not the durable log

## 2. Tool chips + terminal (activity-feed)

- [x] 2.1 `web/src/components/feed/tool_chip.tsx`: collapsible chip for `tool_started`/`tool_finished`/`tool_failed` showing the summarized input (path/command), expandable to detail; never render a full Edit/Write payload
- [x] 2.2 `web/src/components/feed/terminal_block.tsx`: render `terminal_output` (chunked) with `anser` ANSI coloring, scroll-capped

## 3. Run banners + file rows (activity-feed)

- [x] 3.1 `web/src/components/feed/run_banner.tsx`: banners for `run_started`/`run_finished`/`run_failed`/`run_interrupted`/`changeset_ready`; attribute human events to the participant resolved from `actor.id` (participant-name helper), system framing for `run_finished`/`run_failed`
- [x] 3.2 `web/src/components/feed/file_changed_row.tsx`: compact per-file row (path + change indicator); no inline diff
- [x] 3.3 Participant-name resolution helper (`actor.id` → display name from the participants list; short-id fallback)

## 4. Feed assembly + resilience (activity-feed)

- [x] 4.1 `web/src/components/activity_feed.tsx`: switch on `event.type` over the store's ordered durable log + the trailing live text block; mount in the session route, replacing the `web-cable-client` raw-list view
- [x] 4.2 Safe fallback (collapsible raw view) for `ai_raw`/unrecognized types — never crash the feed
- [x] 4.3 Cap/window the rendered durable set so a long run does not render thousands of nodes at once

## 5. Tests (Vitest + RTL)

- [x] 5.1 Render the post-spike `packages/contracts/fixtures/sample_run.jsonl` through the store into the feed; assert streamed-text bubbles, tool chips (summarized input), terminal block, run banners
- [x] 5.2 Delta-flood test: many `ai_text_delta` re-render only the active block (selector isolation holds)
- [x] 5.3 Fallback test: an `ai_raw`/unknown type renders the safe fallback, feed intact
- [x] 5.4 Confirm `web` checks stay green: Biome + tsc + Vitest

## 6. Validation

- [x] 6.1 Run `openspec validate activity-feed-rendering --type change --strict` and confirm valid
- [~] 6.2 Manual: with `sidecar-runner` + `run-orchestration` up, start a real run and watch the feed render streamed text, tool chips, terminal output, and banners live (the W2 watchable milestone)  — *seam-verified: SPA serves via rails:3000, Vite compiles activity_feed in-container, 15 specs render the real fixture; the human browser-watch is the one remaining click*
