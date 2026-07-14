# sidecar-normalizer-v1 Specification

## Purpose
TBD - created by archiving change sidecar-foundation. Update Purpose after archive.
## Requirements
### Requirement: Normalizer is the only SDK-aware file

`sidecar/src/normalizer.ts` SHALL be the **only** file in the sidecar that touches raw `@anthropic-ai/claude-agent-sdk` message shapes. The server (`index.ts`), transport (`transport.ts`), and permissions (`permissions.ts`) SHALL deal only in Contract-1 event envelopes and SHALL NOT reference raw SDK message types. This contains SDK version or shape surprises to one file.

#### Scenario: Only the normalizer references raw SDK shapes

- **WHEN** the sidecar processes an SDK message
- **THEN** only `normalizer.ts` reads its raw shape, and every other sidecar file sees only Contract-1 envelopes

### Requirement: Unknown SDK message degrades to ai_raw, never crashes (v1 rule)

The normalizer SHALL emit any SDK message type it does not recognize or cannot map as an `ai_raw` event, per the `event-envelope` capability's `ai_raw` fallback. An unmapped or malformed SDK message SHALL NEVER be dropped silently and SHALL NEVER throw or crash the sidecar. This never-crash rule is the complete v1 normalizer contract; the full per-type mapping table is spike-gated (see below). Because `ai_raw` serializes opaque SDK content, it is both an unbounded-size risk and a credential-leak vector. The normalizer SHALL process it in this order: **redact first, then truncate**. Redaction SHALL replace, across the full serialized structure, the value of any key whose name matches the case-insensitive regular expression `/(api[_-]?key|token|secret|authorization|bearer|password|passwd|pwd|credential|private[_-]?key|aws[_-]?(secret|access)[_-]?key)/i` with a redaction marker; only after redaction SHALL the content be truncated to a fixed cap (8KB) with a `truncated: true` marker when exceeded, so the durable ingest path never carries an unbounded blob. The pattern matches by key name (case-insensitive substring), so non-obvious credential keys such as `pwd`, `credential`, `private_key`, and `aws_secret_access_key` are redacted alongside the obvious `api_key`/`token`/`secret`/`authorization` names. Redacting before truncating ensures a credential is never leaked by the cap boundary slicing through a key/value pair after the redactor has stopped scanning. Separately, the bearer `SIDECAR_SHARED_SECRET` and any auth tokens SHALL NEVER be logged.

#### Scenario: Unmapped SDK message becomes ai_raw

- **WHEN** the normalizer receives an SDK message whose type it cannot map to a known taxonomy type
- **THEN** it emits an `ai_raw` Contract-1 event carrying the message rather than dropping it

#### Scenario: ai_raw payload is bounded

- **WHEN** an unknown SDK message larger than the cap is degraded to ai_raw
- **THEN** its serialized payload is truncated to the 8KB cap and marked truncated: true, never emitted unbounded

#### Scenario: Credential-like fields are redacted in ai_raw

- **WHEN** an unknown SDK message containing a credential-like field (e.g. `api_key`, `token`, `secret`, `authorization`, or a non-obvious key such as `aws_secret_access_key` or `private_key`) is degraded to `ai_raw`
- **THEN** that field's value is redacted in the emitted `ai_raw` payload because its key name matches the redaction pattern `/(api[_-]?key|token|secret|authorization|bearer|password|passwd|pwd|credential|private[_-]?key|aws[_-]?(secret|access)[_-]?key)/i`, proving the pattern catches more than the four obvious names, and the `SIDECAR_SHARED_SECRET` and any auth tokens are never logged

#### Scenario: Malformed SDK message does not crash the sidecar

- **WHEN** the normalizer receives a malformed or unexpected SDK message
- **THEN** it emits `ai_raw` and the sidecar continues running, never throwing

### Requirement: Normalizer output is the Contract-1 envelope

Every event the normalizer emits SHALL be a Contract-1 event envelope as defined by the `event-envelope` capability, carrying `id`, `session_id`, `ai_run_id`, `seq`, `type`, `actor`, `ts`, and `payload`, with `type` drawn from the frozen taxonomy (or `ai_raw`). Per the frozen `event-envelope` contract, the durable `id` (the global client cursor) is assigned by Rails on ingest, not by the sidecar. The sidecar SHALL assign the per-run monotonic `seq` scoped to `ai_run_id`, SHALL NOT carry `seq` across runs, and SHALL assign `seq` **only** to durable run-scoped events — ephemeral events do not consume `seq` (see the ephemeral-classification requirement). For the `run_started` event the sidecar SHALL stamp `actor` as `{ kind: "user", id: <requested_by> }` using the `requested_by` from the run-start payload (per the `sidecar-protocol` capability). Mirroring `run_started`, the `run_interrupted` event is user-attributed: per the frozen `sidecar-protocol`, `POST /runs/:id/interrupt` carries `{ requested_by }`, and the sidecar SHALL stamp `run_interrupted.actor` as `{ kind: "user", id: <requested_by> }` from the interrupt request body (NOT `{ kind: "system" }`). Claude-originated events carry `{ kind: "claude" }`.

#### Scenario: Emitted events carry the full envelope

- **WHEN** the normalizer maps an SDK message to a known type
- **THEN** the emitted event is a Contract-1 envelope with all envelope fields and a `type` from the frozen taxonomy

#### Scenario: seq is per-run and monotonic

- **WHEN** the normalizer assigns `seq` to events within a run
- **THEN** `seq` increases monotonically within that `ai_run_id` and does not carry over to a different run

#### Scenario: run_interrupted is attributed to the interrupting participant

- **WHEN** the normalizer emits a `run_interrupted` event for an interrupt request carrying `{ requested_by }`
- **THEN** the event's `actor` is `{ kind: "user", id: <requested_by> }` (mirroring `run_started`), not `{ kind: "system" }`

### Requirement: Ephemeral text deltas are classified at the normalizer boundary

The normalizer SHALL treat `ai_text_delta` (and `presence_changed`) as ephemeral per the `event-envelope` capability — broadcast but never persisted — and SHALL coalesce `ai_text_delta` on roughly a 150ms window. The durable `ai_text` record SHALL be emitted on text-block stop, distinct from the ephemeral deltas. The classification SHALL be honored so the durable ingest path never carries ephemeral deltas. Per the frozen `event-envelope` contract, ephemeral events SHALL NOT consume the durable per-run `seq` — `seq` is assigned only to durable run-scoped events — and SHALL carry a **null `id`** (they are assigned no global id by Rails and are not deduped by id). Ephemeral `ai_text_delta` events SHALL instead be accumulated client-side by `(ai_run_id, block)`, with the durable `ai_text` block-stop record being the persisted source of truth.

#### Scenario: Deltas are coalesced and not routed to durable ingest

- **WHEN** the normalizer produces `ai_text_delta` events
- **THEN** they are coalesced (~150ms) and treated as ephemeral, not placed on the durable ingest batch

#### Scenario: Durable ai_text is emitted on block stop

- **WHEN** a text block completes
- **THEN** the normalizer emits a durable `ai_text` event distinct from the preceding ephemeral deltas

#### Scenario: ai_text_delta is emitted without consuming a durable seq

- **WHEN** the normalizer emits an ephemeral `ai_text_delta`
- **THEN** the delta carries a null `id` and does NOT consume the durable per-run `seq`
- **AND** the next durable run-scoped event takes the next `seq` value as though the delta had not been emitted

### Requirement: Full per-type mapping table is spike-gated

The complete per-SDK-type mapping (text deltas, text blocks, thinking, tool start/finish/fail, terminal output, file changes, run lifecycle, result) SHALL be finalized only after the Tuesday SDK spike and SHALL be marked **pending-spike** until then. The Week-1 skeleton SHALL NOT invent the table from guessed SDK shapes; only the never-crash unknown→`ai_raw` behavior is committed pre-spike. The following PLAN requirements are explicitly named as pending-spike obligations so they are not dropped in W2: (a) **cost/usage** — `total_cost_usd` and `usage` SHALL be carried on the `run_finished`/result event; (b) **tool-input summarization** — `tool_started` inputs SHALL be summarized to a path/command/~500-char form and SHALL NEVER carry the full Edit/Write payload; (c) **terminal_output chunking** — Bash output SHALL be emitted in ~64KB chunks rather than as one unbounded blob.

#### Scenario: Per-type mapping is marked pending-spike before the spike

- **WHEN** the normalizer skeleton is built before the SDK spike output is incorporated
- **THEN** the full per-type mapping is explicitly marked pending-spike, not invented from guessed shapes

### Requirement: Raw SDK message fixtures are owned by the sidecar and verified against the contract fixture

This change SHALL own the **raw** SDK message fixtures (captured from the spike) under `sidecar/`, used as the **input** to normalizer unit tests. These are distinct from `packages/contracts/fixtures/sample_run.jsonl`, which is the **post-normalization** output owned by the `freeze-interface-contracts` change. Normalizer unit tests SHALL assert that feeding the raw fixtures through the normalizer produces Contract-1 events equal to the contract's `sample_run.jsonl`, so the two fixture sets are cross-checked.

#### Scenario: Raw fixtures live under sidecar, normalized output lives in the contracts package

- **WHEN** the normalizer tests run
- **THEN** they read the raw SDK fixtures owned under `sidecar/` as input
- **AND** they assert the normalized output equals `packages/contracts/fixtures/sample_run.jsonl` owned by the contracts change

#### Scenario: Fixture drift fails CI

- **WHEN** the normalized output diverges from `sample_run.jsonl`
- **THEN** the normalizer unit test fails, surfacing the drift

