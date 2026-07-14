## Context

`docs/PLAN.md §11` made the spike a hard precondition for finalizing event payloads: the freeze happens
"only after the spike findings are in, never before." W1 shipped the envelope, the 20 type names, the
per-type actor/durability/scope axes, the cursor/idempotency/ephemeral rules, and the actor union as
**frozen** — and explicitly deferred per-type `payload` internals (`events.ts` types them `unknown` via
`EventPayloadMap`; `events.md §8` marks each `pending-spike`; `sample_run.jsonl` is a hand-authored
envelope-only placeholder with `payload: {}`, already verified against every frozen envelope rule). The
sidecar normalizer committed only the never-crash unknown→`ai_raw` behavior and marked the full per-type
mapping `pending-spike`.

So this change is not inventing the contract — it is performing the **one investigation the freeze was
explicitly waiting on**, then filling the deferred slots additively. It runs a real `@anthropic-ai/
claude-agent-sdk` `query()` (the sidecar is the only stream that may touch the SDK), captures the raw message
stream, and derives the concrete per-type mapping. The output unblocks `sidecar-runner` (full normalizer) and
`activity-feed-rendering` (per-type rendering). `web-cable-client` is intentionally independent (opaque payload).

## Goals / Non-Goals

**Goals:**
- Capture a real, representative raw SDK message stream (text, thinking, a file-editing tool call, a Bash
  command, run completion/result) to `sidecar/test/fixtures/raw_run.jsonl`, using the host's inherited login.
- Derive the per-type mapping: each raw SDK message type → Contract-1 `type` + concrete `payload` schema,
  including cost/usage on the result event, tool-input summarization, `terminal_output` chunking, and the
  resolved `ai_text_delta` `block` field.
- Replace the placeholder `sample_run.jsonl` with real post-normalization envelopes (concrete payloads),
  preserving the already-verified envelope/cursor/actor invariants.
- Replace the `unknown` payload stubs in `events.ts` with concrete interfaces; drop the `pending-spike` markers
  in `events.md`.
- Record an **additive** `CONTRACT_VERSION` minor bump + a CHANGELOG entry; prove additivity (consumers
  requiring exact-major + minor≥ still pass).

**Non-Goals:**
- The full normalizer implementation that maps live runs (that is `sidecar-runner`) — this change derives and
  documents the mapping + captures fixtures; the runner consumes them.
- Any feed rendering, run orchestration, or UI.
- Changing the envelope, the 20 type names, any endpoint signature, or the per-type actor/durability/scope
  axes — all of that stays frozen; this is additive only.
- Exhaustive coverage of every conceivable SDK message; the spike captures a representative run sufficient to
  pin the taxonomy mapping, with `ai_raw` still catching anything unmapped at runtime.

## Decisions

**1. The spike runs inside the sidecar container against a throwaway repo, using the host's inherited login.**
The harness calls `query({ prompt, options: { cwd: "/repo", ... } })` and writes every yielded SDK message
verbatim to `raw_run.jsonl`. *Why:* the sidecar is the only stream allowed to import the SDK, it already has
the read-only `~/.claude`/`~/.aws` mounts + passed-through auth env, and `/repo` is bind-mounted. The app owns
no credential and selects no method — the SDK auto-detects, exactly as in production. *Alternative rejected:*
running on the host outside the container — would not exercise the real auth-passthrough path the runner uses.

**2. Capture raw messages verbatim and unredacted into the sidecar-owned fixture; redaction is the normalizer's
job at runtime, not the capture's.** `raw_run.jsonl` is a checked-in test input, so it MUST be reviewed to
contain no real secret before commit, but the capture itself does not transform messages. *Why:* the normalizer
tests need faithful raw input to assert the mapping; the redact-then-truncate rule already lives in the
normalizer (`sidecar-normalizer-v1`) and is what the tests verify. *Guard:* the prompt/repo are chosen so no
credential is in scope, and the fixture is eyeballed before commit.

**3. The mapping is documented as the single source, then encoded in `events.ts`.** A mapping doc records, per
raw SDK type, the Contract-1 `type` and the concrete `payload` fields; `events.ts`'s `EventPayloadMap` then
replaces each `unknown` with a real interface. *Why:* `events.ts` stays the machine-checked source of truth
(its compile-time guards already assert the map covers the taxonomy); the doc carries rationale. The two must
agree — a task cross-checks them, same gate as the W1 freeze.

**4. Tool-input is summarized, not carried whole.** Per `docs/PLAN.md`, `tool_started` payloads summarize input
to a path/command/~500-char form and NEVER carry the full Edit/Write content; `terminal_output` is chunked
(~64KB); the result event carries `total_cost_usd` + `usage`. These are pinned in the payload schemas now so
the runner implements them rather than rediscovering them. *Why:* a full Edit payload would bloat the durable
store and the backfill; this is a known PLAN obligation the W1 normalizer flagged.

**5. The new `sample_run.jsonl` preserves the placeholder's structural invariants.** The real fixture keeps the
same envelope/cursor/actor/scope rules the placeholder's test already asserts (durable ids ascending, ephemeral
null id+seq, per-run seq skipping ephemeral, per-type actor.kind) — only the `payload` objects become real. The
existing `sample_run.test.ts` SHALL still pass, and a new assertion checks payloads are now non-empty for
durable types. *Why:* the structural contract is frozen and verified; the spike only fills payloads.

**6. Additive `CONTRACT_VERSION` minor bump, never major.** Finalizing a `pending-spike` payload is additive by
the governance defined in `contracts-package` — downstream code treated payload as opaque and keeps working. So
`{ major: 1, minor: 0 } → { major: 1, minor: 1 }`, with a CHANGELOG `[1.1.0]` additive entry. The Ruby
`ContractVersion` consumer (rails `FakeClaude::Replay`) requires exact-major + minor≥, so it stays green. *Why:*
this is the exact case the additive-vs-breaking rule was designed for; bumping minor proves the mechanism works.

**7. If the spike cannot run (auth unavailable in the environment), the change blocks rather than fabricates.**
The whole point is real shapes; a hand-guessed mapping would reintroduce the fiction the freeze forbids. If the
host login is not usable at apply time, the capture task is marked blocked and the downstream changes stay
gated — no invented schemas land. *Why:* honors `docs/PLAN.md §11` literally.

## Risks / Trade-offs

- **The external call needs working host auth + quota.** *Mitigation:* uses whatever login the host already has
  (Decision 1); if unavailable, the change blocks rather than fabricating (Decision 7). One short run, throwaway
  repo, minimal token spend.
- **A real secret could leak into the checked-in raw fixture.** *Mitigation:* prompt/repo scoped to contain no
  credential; the fixture is reviewed before commit; the normalizer's redact-then-truncate is the runtime
  backstop (Decision 2).
- **SDK shapes may differ from the draft taxonomy.** *Mitigation:* the 20 type names are frozen, but a message
  that maps to none still degrades to `ai_raw` (never a crash); if the spike reveals a genuinely missing type,
  that is an additive CHANGELOG decision, surfaced explicitly — not silently invented.
- **Spike output could imply a payload too large for the durable path.** *Mitigation:* the summarization/chunking
  decisions (Decision 4) cap it at the contract level before the runner emits it.
- **Drift between the mapping doc, `events.ts`, and the new fixture.** *Mitigation:* a cross-check task asserts
  all three agree before the version bump (the same freeze gate W1 used), and `events.ts`'s compile-time guards
  catch a taxonomy mismatch.

## Open Questions

- The exact representative prompt/turns for the capture are chosen at apply time to exercise text + thinking +
  a file-edit tool + a Bash command + completion; the precise prompt is an implementation detail, not a contract
  decision.
