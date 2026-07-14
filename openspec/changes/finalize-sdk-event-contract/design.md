## Context

The freeze split the event contract into a frozen half (envelope, 20 type names + `ai_raw`, per-type
actor/durability/scope, cursor/idempotency/ephemeral rules) and a `pending-spike` half (payload
internals, the `ai_text_delta` `block` key, the real `sample_run.jsonl`). The placeholder
`sample_run.jsonl` has `{}` payloads and exercises only the frozen envelope rules. This change closes
the spike half. It is cross-stream (contracts package + docs + sidecar) but strictly additive: it fills
in what was deferred and must not contradict any frozen rule.

## Goals / Non-Goals

**Goals:**
- Concrete, spike-derived payload schemas for every durable and ephemeral type, typed in `events.ts`.
- A resolved, documented `ai_text_delta` `block` representation.
- A real `sample_run.jsonl` (post-normalization) plus the raw fixtures that produce it.
- A normalizer mapping proven by a raw-in → normalized-out equality test.

**Non-Goals:**
- Run lifecycle/state machine, worktree, interrupt/follow-up, heartbeat (later sidecar/rails tracks).
- Any change to frozen envelope fields, type names, axes, or the never-crash `ai_raw` fallback.
- UI or Rails changes.

## Decisions

**1. The spike is the source of truth; schemas are derived, not invented.** Capture happens first
(raw messages from a real run against a disposable repo), then every payload schema, the `block` key,
and `sample_run.jsonl` are read off that capture. No schema is written ahead of a captured example.

**2. Two fixture sets stay distinct, per the existing READMEs.** `sidecar/test/fixtures/raw_run.jsonl`
= raw SDK shapes (normalizer input); `packages/contracts/fixtures/sample_run.jsonl` = post-normalization
Contract-1 envelopes (the executable contract). The cross-check test asserts `normalize(raw) == sample`.

**3. Additive `minor` version bump.** Payloads move from opaque (`unknown`) to concrete; the envelope
and consumers that treat payload as opaque keep working, so this is additive, not breaking. Record it in
`CHANGELOG.md` under a new versioned entry.

**4. `ai_text_delta.block` is resolved to whatever stable per-block identifier the SDK exposes**
(e.g. a content-block index within the assistant message). The contract only requires it be stable for
the life of a block and unique within an `(ai_run_id)`; the concrete field name comes from the capture.

**5. Normalizer mapping is per-type and total.** Each captured raw shape maps to exactly one Contract-1
type; anything unmapped or malformed still becomes `ai_raw` (frozen never-crash rule). Deltas coalesce
(~150 ms) and carry null `id`/`seq`; durable events advance per-run `seq`.

## Risks / Trade-offs

- [Capturing the spike requires running real Claude with host credentials — not doable in a CI/headless
  or no-auth environment] → this is a **host activity**: the capture step is run by a developer on a
  machine with the existing Claude login, on a disposable repo; the derived-artifacts steps (schemas,
  interfaces, fixture, mapping, tests) follow from the committed capture and are reviewable normally.
- [Spike output may reveal a message shape not cleanly covered by the 20 types] → that is exactly what
  `ai_raw` is for; capture it, map the clean cases, and leave genuine unknowns as `ai_raw` rather than
  inventing a type (adding a type would be a separate, heavier contract change).
- [The `block` representation could differ across SDK versions] → pin the observation to the repo's
  pinned SDK version; note the version in the CHANGELOG entry so a future SDK bump re-verifies it.
- [Fixture/normalizer drift over time] → the equality cross-check test fails CI on any drift, keeping
  the executable contract honest.

## Migration Plan

Additive minor bump. Replace the placeholder fixture and `unknown` stubs; existing opaque-payload
consumers are unaffected. Rollback = revert (returns to the placeholder). Verified by `tsc`, the
contracts Vitest suite (concrete-payload assertions), and the sidecar normalizer cross-check.

## Open Questions

- Exact set of raw message subtypes the pinned SDK emits for tool use (single `tool_use` vs per-tool
  shapes) — resolved by inspecting the capture; the mapping table is filled from what is actually seen.
