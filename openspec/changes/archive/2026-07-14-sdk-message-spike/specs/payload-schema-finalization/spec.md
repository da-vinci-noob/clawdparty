## ADDED Requirements

### Requirement: Per-type payload schemas are derived from the spike and documented

A per-type mapping SHALL be derived from the captured raw SDK messages and documented as the single source: for
each raw SDK message type, its Contract-1 `type` (one of the frozen 20, or `ai_raw`) and the concrete `payload`
field schema. The mapping SHALL cover the three `docs/PLAN.md` payload obligations the Week-1 normalizer flagged
as pending-spike: (a) **cost/usage** — `total_cost_usd` and `usage` carried on the `run_finished`/result event;
(b) **tool-input summarization** — `tool_started` inputs summarized to a path/command/~500-char form, NEVER the
full Edit/Write payload; (c) **terminal_output chunking** — Bash output emitted in ~64KB chunks. The
`ai_text_delta` `block` field representation (the key the web reducer accumulates deltas by) SHALL be resolved
from spike output.

#### Scenario: Mapping covers every captured SDK message type

- **WHEN** the mapping is derived from `raw_run.jsonl`
- **THEN** each captured SDK message type is mapped to a frozen Contract-1 `type` (or `ai_raw`) with a concrete
  `payload` field schema

#### Scenario: PLAN payload obligations are pinned

- **WHEN** the per-type schemas are documented
- **THEN** the result event carries `total_cost_usd` + `usage`, `tool_started` carries a summarized (not full)
  tool input, `terminal_output` is chunked (~64KB), and the `ai_text_delta` `block` field is resolved

### Requirement: Concrete payload interfaces replace the pending-spike stubs

`packages/contracts/src/events.ts` SHALL replace the `unknown` `PendingSpikePayload` entries in
`EventPayloadMap` with concrete per-type payload interfaces, and `docs/contracts/events.md` SHALL replace its
`pending-spike` payload markers with the concrete schemas. The existing compile-time guards (the
`PAYLOAD_MAP_COVERS_TAXONOMY` and 20-count assertions) SHALL still hold, and `tsc` SHALL pass. The mapping doc,
`events.ts`, and the new `sample_run.jsonl` SHALL be cross-checked to agree before the version bump, matching
the Week-1 freeze gate.

#### Scenario: events.ts carries concrete payload interfaces and still type-checks

- **WHEN** `tsc` type-checks `packages/contracts`
- **THEN** `EventPayloadMap` resolves concrete interfaces (no `unknown` stubs), the taxonomy-coverage and
  20-count guards still hold, and `tsc` passes

#### Scenario: Doc, types, and fixture agree before the bump

- **WHEN** the payload schemas are finalized
- **THEN** the mapping doc, `events.ts` interfaces, and the new `sample_run.jsonl` payloads are cross-checked to
  agree before `CONTRACT_VERSION` is bumped

### Requirement: Real sample_run.jsonl replaces the placeholder, preserving structural invariants

`packages/contracts/fixtures/sample_run.jsonl` SHALL be replaced with post-normalization Contract-1 envelopes
carrying concrete payloads captured from the spike. The new fixture SHALL preserve every structural invariant
the placeholder already satisfied — durable `id`s ascending, ephemeral events with null `id` and null `seq`,
per-run `seq` not advanced by ephemeral events, session-scoped events with null `ai_run_id`/`seq`, and per-type
`actor.kind` matching the frozen table — so the existing `fixtures/sample_run.test.ts` still passes; a new
assertion SHALL additionally check that durable events now carry non-empty payloads (a smoke check —
`Object.keys(payload).length > 0`, i.e. no longer the placeholder `{}`). Per-type payload field validation is
the normalizer cross-check test's job (`sidecar-runner`), not this fixture smoke assertion.

#### Scenario: Existing structural fixture test still passes on the real fixture

- **WHEN** `fixtures/sample_run.test.ts` runs against the real spike-derived fixture
- **THEN** all frozen envelope/cursor/actor/scope assertions still pass

#### Scenario: Durable events now carry real payloads

- **WHEN** the real fixture is inspected
- **THEN** each durable event has `Object.keys(payload).length > 0` (no longer the placeholder `{}`) as a smoke
  check, with per-type field validation deferred to the `sidecar-runner` normalizer cross-check

### Requirement: Payload finalization is an additive CONTRACT_VERSION minor bump

Finalizing the `pending-spike` payloads SHALL be recorded as an **additive** change: `CONTRACT_VERSION` SHALL
bump its `minor` (resetting nothing; `major` unchanged) — `{ major: 1, minor: 0 } → { major: 1, minor: 1 }` —
and `docs/contracts/CHANGELOG.md` SHALL gain an additive `[1.1.0]` entry. The envelope shape, the 20 type names,
the cursor/idempotency/ephemeral rules, the per-type actor/durability/scope axes, and every endpoint signature
SHALL remain unchanged. A consumer asserting compatibility by exact `major` + `minor ≥ needed` SHALL still pass
(e.g. the Rails `ContractVersion`/`FakeClaude::Replay` consumer remains green).

#### Scenario: Minor bump with an additive changelog entry

- **WHEN** the payload schemas are finalized
- **THEN** `CONTRACT_VERSION.minor` is bumped (major unchanged) and an additive entry is added to the CHANGELOG

#### Scenario: No breaking change to envelope, taxonomy, or endpoints

- **WHEN** the change is inspected
- **THEN** the envelope fields, the 20 type names, the cursor/idempotency/ephemeral rules, the per-type axes,
  and all endpoint signatures are unchanged — the diff is additive only

#### Scenario: Existing exact-major consumer stays compatible

- **WHEN** a consumer requiring an exact `major` and `minor ≥` its needed minor checks the bumped version
- **THEN** it remains compatible (the major is unchanged and the minor only increased)
