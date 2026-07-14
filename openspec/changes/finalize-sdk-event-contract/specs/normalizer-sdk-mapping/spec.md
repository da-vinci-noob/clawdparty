## ADDED Requirements

### Requirement: Raw SDK messages map to Contract-1 events

`sidecar/src/normalizer.ts` SHALL map each captured raw `@anthropic-ai/claude-agent-sdk` message shape
to exactly one Contract-1 event of the correct type, covering at least: text streaming
(`ai_text_delta` → `ai_text` on block stop), thinking (`ai_thinking`), Bash (`tool_started` /
`tool_finished` / `tool_failed` + `terminal_output`), Edit/Write (`file_changed`), successful result
(`run_finished`), failure (`run_failed`), and interrupt (`run_interrupted`). Durable events SHALL
advance the per-run `seq`; `ai_text_delta` SHALL be ephemeral (null `id`/`seq`) and coalesced. Any
unmapped or malformed message SHALL become `ai_raw` and SHALL NOT crash the normalizer.

#### Scenario: Each captured type maps correctly

- **WHEN** a captured raw message of a known kind passes through the normalizer
- **THEN** it produces the Contract-1 event type mandated by the per-type table with a concrete payload

#### Scenario: Unknown message is preserved as ai_raw

- **WHEN** a raw message shape not covered by the mapping (or a malformed one) is normalized
- **THEN** the normalizer emits an `ai_raw` event and does not throw

### Requirement: Raw-in to normalized-out equality check

A test SHALL feed `sidecar/test/fixtures/raw_run.jsonl` through the normalizer and assert the output is
equal to `packages/contracts/fixtures/sample_run.jsonl` (the executable contract), so drift between the
raw capture, the normalizer, and the contract fixture fails CI.

#### Scenario: Normalizer output matches the executable contract

- **WHEN** the raw fixtures are normalized in order
- **THEN** the resulting Contract-1 envelopes equal `sample_run.jsonl`
- **AND** any change that breaks this equality fails the sidecar CI job
