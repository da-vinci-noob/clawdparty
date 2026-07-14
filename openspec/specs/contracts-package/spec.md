# contracts-package Specification

## Purpose
TBD - created by archiving change freeze-interface-contracts. Update Purpose after archive.
## Requirements
### Requirement: Shared TypeScript contract package

The repository SHALL contain a `packages/contracts/` TypeScript package that is the machine-checked source of truth for the event envelope and type-name taxonomy. It SHALL export the envelope type and the union of frozen type names from `src/events.ts`, and SHALL include its own package scaffolding (`package.json`, `tsconfig.json`, Biome configuration) consistent with the repo's strict-TS and Biome conventions. Per-type payload interfaces MAY be stubbed and marked `pending-spike` until the spike output is incorporated. The package SHALL export a `CONTRACT_VERSION` constant from `src/events.ts` as a `{ major, minor }` integer pair: `minor` bumps on an additive CHANGELOG entry (new event type, new optional field), and `major` bumps (resetting `minor` to 0) on a breaking entry (envelope or endpoint-signature change). A consumer asserts compatibility by requiring an **exact `major`** and a **`minor` ≥** what it needs — so a breaking `major` bump fails the assertion rather than silently passing a `≥` check, while an additive `minor` bump remains compatible.

#### Scenario: Envelope and type names are importable

- **WHEN** the `sidecar/` or `web/` stream imports from `packages/contracts`
- **THEN** it receives the envelope type, the frozen type-name union, and the `CONTRACT_VERSION` constant as TypeScript exports

#### Scenario: Payload interfaces may be stubbed pre-spike

- **WHEN** the package is published before the spike output is incorporated
- **THEN** unfinalized per-type payload interfaces are present but explicitly marked `pending-spike`, and `tsc` still passes

### Requirement: Executable contract fixture

The package SHALL contain `fixtures/sample_run.jsonl` as the executable contract: a sequence of **post-normalization** contract events (envelopes), captured from the real Tuesday SDK spike. The fixture SHALL be consumable by all three streams — the web renders it, a Rails fake-Claude rake task replays it through real ingest, and the sidecar normalizer tests assert producing it. The fixture SHALL NOT contain raw SDK message shapes; raw SDK logs are a separate fixture set owned by the sidecar stream.

#### Scenario: Fixture is normalized contract events

- **WHEN** any stream reads `fixtures/sample_run.jsonl`
- **THEN** every line is a Contract-1 event envelope, not a raw SDK message

#### Scenario: One fixture serves all three streams

- **WHEN** the fixture exists
- **THEN** the same file can be rendered by the web, replayed through Rails ingest, and asserted as normalizer output

#### Scenario: Interim envelope-only fixture if the spike slips

- **WHEN** the spike output is not yet available by the freeze deadline
- **THEN** a hand-authored envelope-only fixture may stand in to unblock ingest plumbing, to be replaced by real spike-derived events

### Requirement: Contract governance and changelog

The contract SHALL be governed by `docs/contracts/CHANGELOG.md`. After the freeze, additive new event types SHALL require only a CHANGELOG entry, while changes to the envelope or to a frozen endpoint signature SHALL be treated as breaking — recorded as a breaking CHANGELOG entry and handled as an emergency. The CHANGELOG SHALL be seeded with the v1 freeze entry at freeze time.

#### Scenario: Additive type needs only a changelog entry

- **WHEN** a new event type is added after the freeze
- **THEN** the change is allowed with a CHANGELOG entry alone

#### Scenario: Envelope change is breaking

- **WHEN** an envelope field or a frozen endpoint signature is changed
- **THEN** the change is recorded as a breaking CHANGELOG entry and handled as an emergency

### Requirement: Freeze-now versus spike-gated boundary is documented

The contract package and docs SHALL make explicit which parts are frozen immediately (envelope fields, type names, endpoint signatures, worktree convention, role matrix) and which are spike-gated (per-type payload schemas, concrete `events.ts` payload interfaces, `sample_run.jsonl`). The boundary SHALL be stated so downstream streams know what they can build against before Wednesday.

#### Scenario: Downstream knows what is safe to build against

- **WHEN** a downstream stream begins work before the Wednesday freeze
- **THEN** it can determine from the contract that the envelope, names, endpoints, worktree convention, and role matrix are stable, while payload internals are still `pending-spike`

