## ADDED Requirements

### Requirement: Streamed text renders live and resolves to a durable bubble

The activity feed SHALL render assistant text as it streams: the in-progress text accumulated by
`(ai_run_id, block)` in the `web-cable-client` store SHALL render as a live (typing) block, and on text-block
stop the durable `ai_text` event SHALL become the persisted message bubble. The live text SHALL be
selector-isolated so a flood of deltas re-renders only the active block, not the whole feed.

#### Scenario: Text appears as it streams and settles on block stop

- **WHEN** `ai_text_delta` events accumulate for a block and then the block stops
- **THEN** the feed shows the text growing live and then renders the durable `ai_text` bubble, with only the
  active block re-rendering during the delta flood

### Requirement: Tool activity renders as collapsible chips with summarized input

`tool_started`/`tool_finished`/`tool_failed` events SHALL render as compact, collapsible chips showing the
**summarized** tool input (path/command form, per the spike payload schema) — never the full Edit/Write
payload — expandable to the finish/fail detail. `terminal_output` events SHALL render in a legible,
scroll-capped block with ANSI coloring (via `anser`).

#### Scenario: Tool chip shows the summary, not the full payload

- **WHEN** a `tool_started` event renders
- **THEN** the chip shows the summarized path/command input, expandable to the `tool_finished`/`tool_failed`
  detail, and never renders a full Edit/Write payload (the event does not carry it)

#### Scenario: Terminal output renders with ANSI color, scroll-capped

- **WHEN** a `terminal_output` event renders
- **THEN** its (chunked) content renders with `anser` ANSI coloring inside a scroll-capped block

### Requirement: Run lifecycle renders as participant-attributed banners

`run_started`/`run_finished`/`run_failed`/`run_interrupted`/`changeset_ready` SHALL render as banners framing a
run. Human-originated events (`run_started`, `run_interrupted`) SHALL be attributed to the acting participant,
resolving `actor.id` to a display name via the participants list (per the frozen `event-envelope`: actor carries
the id, names resolved client-side). System events (`run_finished`/`run_failed`) SHALL render as system framing.

#### Scenario: run_started banner names the requester

- **WHEN** a `run_started` event renders
- **THEN** the banner attributes it to the participant resolved from `actor.id`, falling back to a short
  id/placeholder if the name is not yet locally known

#### Scenario: System lifecycle events render as system framing

- **WHEN** a `run_finished` or `run_failed` event renders
- **THEN** it renders as a system-framed banner (no participant attribution), consistent with its `system` actor

### Requirement: file_changed renders as a compact row

`file_changed` events SHALL render as a compact per-file row in the feed (path + change indicator). The full
diff SHALL NOT be rendered inline — it is reviewed via the diff API / W3 review screen.

#### Scenario: file_changed shows a compact row, not the full diff

- **WHEN** a `file_changed` event renders
- **THEN** the feed shows a compact per-file row, with the full diff deferred to the review screen

### Requirement: The feed survives a delta flood and unknown types

The feed SHALL remain responsive during a run emitting 10–20k deltas: components SHALL subscribe via selectors
so a delta does not re-render the durable log, and the rendered durable set SHALL be capped/windowed. An event
of an unrecognized type (or `ai_raw`) SHALL render a safe fallback (e.g. a collapsible raw view) rather than
breaking the feed.

The following frozen types are **intentionally not rendered by this change** (the gap is by design, not an
omission): `chat_message`, `participant_joined`, and `presence_changed` are owned by `prompt-composer-chat`
(the chat panel / participant list, not the activity feed); `ai_thinking` renders only once its payload shape
lands from `sdk-message-spike` (until then it rides the `ai_raw`/unknown fallback); and `changeset_approved` /
`changeset_rejected` / `task_created` / `task_updated` belong to W3 / the cut task board and have no producer in
the Week-2 set. All of these degrade to the safe fallback rather than erroring.

#### Scenario: Chat/presence/task types are not rendered by the feed

- **WHEN** the feed encounters a `chat_message`, `participant_joined`, `presence_changed`, or `task_*` event
- **THEN** the activity feed does not render it as feed content (those are owned by the chat panel / W3), and it
  degrades to the safe fallback rather than erroring

#### Scenario: A high-delta run stays responsive

- **WHEN** a run emits tens of thousands of `ai_text_delta` events
- **THEN** only the active text block re-renders and the feed remains responsive, with the durable set
  capped/windowed

#### Scenario: Unknown or ai_raw type degrades gracefully

- **WHEN** the feed encounters an `ai_raw` or otherwise-unrendered type
- **THEN** it renders a safe fallback (e.g. a collapsible raw view) without crashing the feed

### Requirement: The feed renders the executable contract fixture in tests

Component tests SHALL render the post-spike `packages/contracts/fixtures/sample_run.jsonl` through the
`web-cable-client` store into the feed and assert the resulting text bubbles, tool chips (with summarized input),
terminal block, and run banners — making the feed a consumer of the executable contract.

#### Scenario: Rendering the contract fixture produces the expected feed

- **WHEN** the test feeds `sample_run.jsonl` through the store into the activity feed
- **THEN** it asserts the expected streamed-text bubbles, collapsible tool chips with summarized input, the
  terminal block, and the run banners
