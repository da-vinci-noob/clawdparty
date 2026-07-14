## Why

The Week-1 freeze deliberately shipped the envelope, type names, and per-type axes frozen but left
every `payload` internal `pending-spike` — schemas invented before seeing real SDK output are fiction
(`events.md §8`, `freeze-interface-contracts` tasks 5.1–5.5 still open). Until real
`@anthropic-ai/claude-agent-sdk` output is captured and turned into concrete payload schemas + a real
`sample_run.jsonl`, no payload-dependent work (activity-feed rendering, the `(ai_run_id, block)` delta
accumulation, the full normalizer mapping) can be built on solid ground. This change runs the spike and
finalizes the contract's payload half.

## What Changes

- Run the SDK spike on a disposable repo and capture **raw** SDK messages for: text streaming, thinking,
  Bash, Edit/Write, successful result, failure, interrupt, follow-up, and resume — saved as
  `sidecar/test/fixtures/raw_run.jsonl` (the normalizer test input).
- Define concrete per-type `payload` field schemas in `events.md §6/§8` (replace the `pending-spike`
  markers) and implement them as typed interfaces in `packages/contracts/src/events.ts` (replace the
  `unknown` stubs in `EventPayloadMap`); `tsc` passes.
- **Resolve the `ai_text_delta` `block` field representation** from spike output — the key the W2 web
  reducer accumulates deltas by — and remove its `pending-spike` marker.
- Replace `packages/contracts/fixtures/sample_run.jsonl` with real spike-derived **post-normalization**
  envelopes carrying concrete payloads; drop the placeholder warning in `fixtures/README.md`. Update
  `fixtures/sample_run.test.ts` to assert the concrete payloads (keeping the frozen-envelope assertions).
- Implement the per-type raw→Contract-1 mapping in `sidecar/src/normalizer.ts`, and add the cross-check
  test: raw fixtures → normalizer → **equal to** `sample_run.jsonl` (drift fails CI). Unknown/malformed
  still → `ai_raw`, never a crash.
- Bump `CONTRACT_VERSION` (**additive minor** — payloads move from opaque to concrete) and add a
  `CHANGELOG.md` entry.

## Capabilities

### New Capabilities
- `sdk-event-payloads`: the concrete per-type `payload` field schemas (previously `pending-spike`), the
  resolved `ai_text_delta` `block` key, the typed `events.ts` interfaces, and the real executable
  `sample_run.jsonl`.
- `normalizer-sdk-mapping`: the mapping from each captured raw SDK message shape to its Contract-1 event,
  plus the raw-in → normalized-out equality check against the executable fixture.

### Modified Capabilities
<!-- None modeled as deltas: the frozen capabilities (event-envelope, contracts-package,
     sidecar-normalizer-v1) live in openspec/changes/*, not archived to openspec/specs/, and the
     payload internals were explicitly deferred (pending-spike), so finalizing them is ADDED content
     that consumes — never contradicts — the frozen envelope/axes/never-crash rules. -->

## Impact

- **packages/contracts:** `src/events.ts` (payload interfaces, `CONTRACT_VERSION` bump),
  `fixtures/sample_run.jsonl` (replaced), `fixtures/README.md` (drop placeholder), `fixtures/sample_run.test.ts`.
- **docs/contracts:** `events.md §6/§8/§9` (concrete schemas, remove `pending-spike`), `CHANGELOG.md`.
- **sidecar:** `src/normalizer.ts` (per-type mapping), `test/fixtures/raw_run.jsonl` (new), a normalizer
  cross-check test.
- **Consumes (unchanged):** the frozen `event-envelope` axes, `contracts-package` freeze guards, and the
  `sidecar-normalizer-v1` never-crash/redact/ephemeral/`seq` behavior.
- **Unblocks:** `web-cable-reducer` task 2.4, `web-activity-feed`, and the `sidecar-run-loop` streaming.
- **Out of scope:** the run lifecycle/state machine, worktree creation, interrupt/follow-up wiring
  (those are `sidecar-run-loop` / `rails-run-orchestration`); no UI, no Rails changes.
- **Governance:** post-freeze change → `CHANGELOG.md` entry; additive `minor` version bump.
