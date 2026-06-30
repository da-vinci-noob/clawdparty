## ADDED Requirements

### Requirement: Full per-type mapping implements the spike-derived schemas

`normalizer.ts` SHALL implement the complete per-type SDK→Contract-1 mapping finalized by `sdk-message-spike`,
replacing the `pending-spike` table: assistant text deltas → ephemeral `ai_text_delta` (coalesced ~150ms, null
`id`/`seq`) with a durable `ai_text` emitted on text-block stop; thinking → `ai_thinking`; tool start/finish/fail
→ `tool_started`/`tool_finished`/`tool_failed`; Bash output → `terminal_output`; file edits → `file_changed`; the
result message → `run_finished`. Each emitted event SHALL be a Contract-1 envelope with `type` from the frozen
taxonomy. The never-crash unknown→`ai_raw` rule SHALL be retained for any message the mapping does not cover,
**redacting credentials FIRST and THEN truncating to the 8KB cap** (the order is load-bearing: truncating first
could split a key/value pair across the cap boundary and leak a secret the redactor never scanned), exactly as
the `sidecar-normalizer-v1` capability defines it.

#### Scenario: Each captured SDK message type maps to its frozen Contract-1 type

- **WHEN** the normalizer processes a message of a type covered by the spike mapping
- **THEN** it emits the corresponding Contract-1 event (e.g. text-block stop → durable `ai_text`, tool call →
  `tool_started`/`tool_finished`), and an uncovered/malformed message still degrades to `ai_raw` without throwing

#### Scenario: Deltas are ephemeral and coalesced; durable ai_text on block stop

- **WHEN** the normalizer receives a stream of assistant text deltas
- **THEN** it emits ephemeral `ai_text_delta` (coalesced ~150ms, null `id`/`seq`) and a durable `ai_text` on
  block stop, distinct from the deltas

### Requirement: Tool input is summarized; terminal output is chunked; result carries cost/usage

Per the spike-finalized payload schemas (the three `docs/PLAN.md` obligations), `tool_started` payloads SHALL
carry a **summarized** tool input (path/command/~500-char form) and SHALL NEVER carry the full Edit/Write
content; `terminal_output` SHALL be emitted in ~64KB chunks rather than one unbounded blob; and the
`run_finished`/result event SHALL carry `total_cost_usd` and `usage`.

#### Scenario: Tool input is summarized, never the full payload

- **WHEN** the normalizer maps a file-editing tool call
- **THEN** the `tool_started` payload carries a path/command/~500-char summary, not the full Edit/Write content

#### Scenario: Terminal output is chunked

- **WHEN** a Bash command produces large output
- **THEN** the normalizer emits `terminal_output` in ~64KB chunks rather than a single unbounded payload

#### Scenario: Result event carries cost and usage

- **WHEN** the run completes
- **THEN** the `run_finished` event carries `total_cost_usd` and `usage`

### Requirement: Raw fixtures cross-check against the contract fixture (drift fails CI)

A normalizer test SHALL feed the sidecar-owned raw fixtures (`sidecar/test/fixtures/raw_run.jsonl`, captured by
`sdk-message-spike`) through the normalizer and assert the produced Contract-1 events equal
`packages/contracts/fixtures/sample_run.jsonl`. Divergence SHALL fail the test, so the two fixture sets stay in
sync and the normalizer doubles as contract verification (the `sidecar-normalizer-v1` deferred task 5.4, now
unblocked).

#### Scenario: Normalized raw fixtures equal the contract fixture

- **WHEN** the normalizer processes `raw_run.jsonl`
- **THEN** its output equals `packages/contracts/fixtures/sample_run.jsonl`

#### Scenario: Drift fails the test

- **WHEN** the normalized output diverges from `sample_run.jsonl`
- **THEN** the cross-check test fails, surfacing the drift in CI

### Requirement: Normalizer remains the only SDK-aware file

The full mapping SHALL preserve the invariant that `normalizer.ts` is the ONLY sidecar file touching raw SDK
message shapes; `runner.ts`, `index.ts`, and `transport.ts` SHALL continue to deal only in Contract-1 envelopes.

#### Scenario: Only the normalizer reads raw SDK shapes after the runner lands

- **WHEN** the runner drives a live `query()`
- **THEN** it passes raw SDK messages to `normalizer.ts` for mapping, and no other file references raw SDK
  message types
