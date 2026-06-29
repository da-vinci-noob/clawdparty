## Why

The Week-1 freeze deliberately left every per-type event `payload` schema marked **`pending-spike`** and
shipped `packages/contracts/fixtures/sample_run.jsonl` as a hand-authored envelope-only placeholder (all
`payload: {}`). This was the plan's hard rule: *"schemas invented before the spike are fiction"*
(`docs/PLAN.md §11`). The Tuesday-of-Week-1 SDK spike that was meant to produce the real shapes **was never
run** — W1 was built against the placeholder on purpose.

That spike is now the **gate for the rest of Week 2**: the sidecar normalizer's per-type mapping
(`sidecar-foundation` left it `pending-spike`) and the rich activity-feed rendering (streamed text, tool
chips, terminal output, run banners) both need to know the **real shapes** of `@anthropic-ai/claude-agent-sdk`
messages. Inventing them blind would violate the freeze discipline and guarantee rework. This change runs the
spike for real — a genuine `query()` against a throwaway repo using the host's existing Claude login — captures
the raw SDK message stream, derives the per-type Contract-1 mapping, and replaces the placeholder fixture with
real spike-derived events. It then records the now-concrete payload schemas as an **additive** `CONTRACT_VERSION`
minor bump, honoring the governance we built the freeze around (additive types/fields are cheap; the envelope
never changes).

## What Changes

- **A spike harness in the sidecar** that runs a real `@anthropic-ai/claude-agent-sdk` `query()` against a
  throwaway git repo (a few representative turns: text, thinking, a tool call that edits a file, a Bash command,
  run completion), dumping **every raw SDK message** to `sidecar/test/fixtures/raw_run.jsonl` (the raw-input
  fixture the normalizer tests consume). Uses the host login inherited via the existing mounts/env — the app
  owns no credential.
- **The derived per-type mapping**, documented: each raw SDK message type → its Contract-1 `type` + the concrete
  `payload` field schema, including the three PLAN obligations the W1 normalizer flagged as pending-spike —
  cost/usage on the result event, tool-input summarization (path/command/~500 chars, never the full Edit/Write
  payload), and `terminal_output` ~64KB chunking — plus the resolved `ai_text_delta` `block` field
  representation (the key the web reducer accumulates by).
- **The real `packages/contracts/fixtures/sample_run.jsonl`** — post-normalization Contract-1 envelopes with
  concrete payloads, captured from the spike, replacing the envelope-only placeholder. The interim placeholder's
  envelope/cursor/actor rules are preserved (already verified); only the `{}` payloads become real.
- **Concrete per-type payload interfaces in `packages/contracts/src/events.ts`** — replacing the `unknown`
  `PendingSpikePayload` stubs in `EventPayloadMap` with real interfaces, and removing the `pending-spike`
  markers in `docs/contracts/events.md §8`.
- **An additive contract version bump + CHANGELOG entry** — `CONTRACT_VERSION` minor bumped (major unchanged),
  recorded as an additive entry in `docs/contracts/CHANGELOG.md`. Consumers requiring exact-major + minor≥
  stay compatible.

This change runs an investigation and finalizes already-deferred contract content. It implements **no** run
orchestration, **no** runner loop, and **no** feed rendering — those consume its output (`sidecar-runner`,
`activity-feed-rendering`). It does not change the envelope, the 20 type names, or any endpoint signature.

## Capabilities

### New Capabilities
- `sdk-spike-capture`: The spike harness + the raw-SDK-message fixture (`sidecar/test/fixtures/raw_run.jsonl`)
  captured from a real `query()` using the host's inherited Claude login, owned by the sidecar stream — the
  documented input to the normalizer tests, distinct from the contract's post-normalization fixture.
- `payload-schema-finalization`: The obligation to move every per-type `payload` schema from `pending-spike`
  to concrete — real interfaces replacing the `unknown` stubs in `events.ts`, the real `sample_run.jsonl`
  replacing the envelope-only placeholder, the resolved `ai_text_delta` `block` field, and the three PLAN
  obligations (cost/usage, tool-input summarization, terminal_output chunking) — recorded as an **additive**
  `CONTRACT_VERSION` minor bump + CHANGELOG entry. Additive ONLY: the envelope shape, the 20 type names, the
  cursor/idempotency/ephemeral rules, and the actor union are unchanged. (Modeled as ADDED requirements rather
  than a delta against `freeze-interface-contracts` because that change is not yet archived into
  `openspec/specs/`; the additive-not-breaking guarantee is itself a requirement here.)

### Modified Capabilities
<!-- None as OpenSpec deltas: the base specs (event-envelope, contracts-package) are not yet archived to
     openspec/specs/, so there is no base to attach a delta to. The additive refinement of those frozen
     capabilities is expressed as ADDED requirements under `payload-schema-finalization`, which explicitly
     constrains the change to be additive (no envelope/taxonomy/endpoint change). -->


## Impact

- **New files:** the sidecar spike harness (e.g. `sidecar/scripts/spike_capture.ts`),
  `sidecar/test/fixtures/raw_run.jsonl` (real raw SDK messages), and a derived mapping doc
  (`docs/contracts/sdk_mapping.md` or an `events.md §8` rewrite).
- **Modified files:** `packages/contracts/src/events.ts` (concrete payload interfaces),
  `packages/contracts/fixtures/sample_run.jsonl` (real capture replaces placeholder),
  `docs/contracts/events.md` (payload schemas, drop `pending-spike`), `docs/contracts/CHANGELOG.md` (additive
  entry), `CONTRACT_VERSION` minor bump.
- **Runs an external call:** one real Claude run via the host's existing login (API key / subscription OAuth /
  Bedrock — whatever the host has), against a throwaway repo. Uses the developer's auth/quota; the app owns no
  credential. This is the one change that genuinely talks to Anthropic.
- **Cross-stream / sequencing:** this is the **Week-2 gate**. `sidecar-runner` (full normalizer) and
  `activity-feed-rendering` (per-type rendering) consume its output and SHOULD be applied after it.
  `web-cable-client` does NOT depend on it (it treats payload as opaque) and may land before or in parallel.
- **Dependencies:** `freeze-interface-contracts` (frozen envelope/taxonomy it refines additively) and
  `sidecar-foundation` (the normalizer + raw-fixture seam + the running sidecar container the harness uses).
