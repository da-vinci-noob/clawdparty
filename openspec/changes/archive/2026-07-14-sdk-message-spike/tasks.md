## 1. Spike harness (sdk-spike-capture)

- [x] 1.1 Write the sidecar spike harness (e.g. `sidecar/scripts/spike_capture.ts`): run `@anthropic-ai/claude-agent-sdk` `query()` against a throwaway repo bind-mounted at `/repo`, with a prompt exercising text + thinking + a file-editing tool + a Bash command + completion
- [x] 1.2 Confirm the harness contains NO app-owned credential and NO auth-method selection — auth is inherited from the host environment (SDK auto-detects), consistent with `claude-auth-passthrough`
- [x] 1.3 Dump every raw SDK message verbatim (no transform/redact/reorder) to `sidecar/test/fixtures/raw_run.jsonl`
- [x] 1.4 Run the harness in the sidecar container using the host's inherited login; if auth is unusable, mark blocked and STOP (do not fabricate a mapping/fixture — `docs/PLAN.md §11`)
- [x] 1.5 Review `raw_run.jsonl` to contain no real secret before committing; confirm the prompt/repo had no credential in scope

## 2. Derive the per-type mapping (payload-schema-finalization)

- [x] 2.1 From `raw_run.jsonl`, derive each raw SDK message type → Contract-1 `type` + concrete `payload` field schema; write the mapping doc (`docs/contracts/sdk_mapping.md` or an `events.md §8` rewrite) as the single source
- [x] 2.2 Pin the three PLAN payload obligations: `total_cost_usd` + `usage` on `run_finished`/result; `tool_started` input summarized to path/command/~500 chars (never full Edit/Write); `terminal_output` ~64KB chunking
- [x] 2.3 Resolve the `ai_text_delta` `block` field representation (the web-reducer accumulation key) and document it

## 3. Finalize the contract (payload-schema-finalization)

- [x] 3.1 Replace the `unknown` `PendingSpikePayload` entries in `packages/contracts/src/events.ts` `EventPayloadMap` with concrete per-type interfaces; keep the `PAYLOAD_MAP_COVERS_TAXONOMY` + 20-count guards passing; `tsc` clean
- [x] 3.2 Replace the `pending-spike` payload markers in `docs/contracts/events.md §8` with the concrete schemas
- [x] 3.3 Replace `packages/contracts/fixtures/sample_run.jsonl` with real post-normalization envelopes (concrete payloads), preserving the placeholder's structural invariants (ascending durable ids, ephemeral null id+seq, per-run seq skips ephemeral, per-type actor.kind)
- [x] 3.4 Update `fixtures/sample_run.test.ts`: keep all frozen structural assertions; add a smoke assertion that durable events carry non-empty payloads (`Object.keys(payload).length > 0`, not `{}`) — per-type field validation is the `sidecar-runner` normalizer cross-check, not here
- [x] 3.5 Cross-check that the mapping doc, `events.ts` interfaces, and the new `sample_run.jsonl` agree (the W1 freeze gate)

## 4. Additive version bump + changelog (payload-schema-finalization)

- [x] 4.1 Bump `CONTRACT_VERSION` minor: `{ major: 1, minor: 0 } → { major: 1, minor: 1 }` (major unchanged) in `events.ts`
- [x] 4.2 Add an additive `[1.1.0]` entry to `docs/contracts/CHANGELOG.md` describing the finalized payloads; confirm the envelope/taxonomy/endpoint signatures are unchanged (additive only)
- [x] 4.3 Confirm the Rails `ContractVersion`/`FakeClaude::Replay` consumer (exact-major + minor≥) stays green against the bump; run the contracts-package Vitest + the rails replay spec

## 5. Validation

- [x] 5.1 Run `openspec validate sdk-message-spike --type change --strict` and confirm valid
- [x] 5.2 Confirm `packages/contracts` (tsc + Biome + Vitest) and the `sidecar` checks stay green with the real fixture + concrete interfaces
