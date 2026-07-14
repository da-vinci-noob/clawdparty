## ADDED Requirements

### Requirement: Concrete per-type payload schemas

Every event type in the frozen taxonomy SHALL have a concrete `payload` field schema documented in
`events.md` and typed in `packages/contracts/src/events.ts` (replacing the `unknown` stubs in
`EventPayloadMap`), derived from captured SDK spike output. The schemas SHALL NOT alter any frozen
envelope field, type name, or per-type actor/durability/scope axis. `tsc` SHALL pass over the
contracts package with the concrete interfaces in place.

#### Scenario: Payloads are concrete and typed

- **WHEN** the contracts package is type-checked after finalization
- **THEN** no payload in `EventPayloadMap` is `unknown` and `tsc` passes
- **AND** `events.md` contains a concrete field schema for each type with no `pending-spike` marker
  remaining

#### Scenario: Frozen rules preserved

- **WHEN** the concrete schemas are applied
- **THEN** the envelope fields, the 20 type names + `ai_raw`, and the per-type actor/durability/scope
  table are unchanged from the freeze

### Requirement: Resolved ai_text_delta block key

The `ai_text_delta` payload SHALL carry a concrete, documented `block` identifier resolved from spike
output, stable for the life of a text block and unique within an `ai_run_id`, so the Week-2 web reducer
can accumulate deltas by `(ai_run_id, block)`. The `pending-spike` marker for the `block` field SHALL be
removed.

#### Scenario: Deltas are groupable by block

- **WHEN** a sequence of `ai_text_delta` events for one assistant text block is emitted
- **THEN** every delta in that block carries the same `block` value
- **AND** a subsequent block within the same run carries a different `block` value

### Requirement: Real executable fixture

`packages/contracts/fixtures/sample_run.jsonl` SHALL be replaced with real spike-derived
**post-normalization** Contract-1 envelopes carrying concrete payloads, covering text streaming,
thinking, Bash, Edit/Write, successful result, failure, interrupt, follow-up, and resume. The
placeholder warning in `fixtures/README.md` SHALL be removed, and `fixtures/sample_run.test.ts` SHALL
assert the concrete payloads in addition to the existing frozen-envelope rules. `CONTRACT_VERSION` SHALL
receive an additive minor bump with a `CHANGELOG.md` entry.

#### Scenario: Fixture carries concrete payloads

- **WHEN** `sample_run.jsonl` is loaded and validated by its test
- **THEN** payloads are non-empty and match the documented schemas
- **AND** every frozen-envelope assertion (cursor, ephemerality, seq monotonicity, actor axes) still holds

#### Scenario: Version bump recorded

- **WHEN** the contract is finalized
- **THEN** `CONTRACT_VERSION` is bumped (minor) and `CHANGELOG.md` records the additive change with the
  pinned SDK version noted
