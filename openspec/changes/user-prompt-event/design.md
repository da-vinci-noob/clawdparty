## Context

The activity feed is reconstructed **purely from the event stream** (the load-bearing invariant: "the event
stream alone must be able to reconstruct the UI"). Today the human's prompt never enters that stream: in
`Runs::Start` the prompt is persisted on `AiRun.prompt` and POSTed to the sidecar, which pushes it into the
SDK's streaming-input iterable (`sidecar/src/runner.ts` → `PushableInput.push(userMessage(...))`) — once for
the initial prompt in `startRun`, once per follow-up in `sendMessage`. Claude's reply comes back as `ai_text`
and renders, but the originating words are invisible, especially to a late joiner whose catch-up is backfilled
from persisted events only.

Two frozen constraints decide the shape of the fix:

1. **`seq` ownership.** The per-run `seq` space `[1, 2, 3, …]` is assigned **exclusively by the sidecar's
   `Normalizer` (`++this.seq`, run_started = seq 1)**. Rails only ever emits **session-scoped** events
   (`ai_run_id: null`, `seq: null` — e.g. `chat_message`), which bypass the `[ai_run_id, seq]` unique index
   because Postgres treats NULLs as distinct. Rails has **no safe run-scoped `seq`** to claim without risking a
   collision. Therefore a run-scoped `user_prompt` must be emitted by the sidecar, not Rails.
2. **Additive contract discipline.** The envelope, scalar field types, the `Actor` union, and all endpoint
   signatures are frozen. Adding a taxonomy name is the explicitly-sanctioned *additive* change: a `minor`
   `CONTRACT_VERSION` bump + a `CHANGELOG.md` entry. The `freeze-interface-contracts` consumers assert exact
   `major` + `minor >=` needed, so a `1.1 → 1.2` bump is non-breaking (already proven across `1.0 → 1.1`).

## Goals / Non-Goals

**Goals:**
- The human's prompt and every mid-run follow-up appear in the activity feed, in correct `seq` order relative
  to Claude's output, attributed to the requesting participant.
- Gap-free for late joiners: `user_prompt` is **durable** and rides the existing sidecar→Rails ingest +
  backfill path — no new endpoint, no bespoke cable message.
- Zero change to the envelope, `seq`/idempotency rules, run-control flow, or `chat_message`.

**Non-Goals:**
- A separate HTTP endpoint or Rails-originated run event (rejected — Rails cannot own a run `seq`; see
  Decision 1).
- Echoing the prompt into the chat panel (chat stays session-scoped; the prompt is part of the *run*
  transcript in the center feed).
- Streaming/partial prompt rendering, editing, or threading — the prompt is a single durable event per
  submission.
- Any change to how `AiRun.prompt` is stored (it stays; `user_prompt` is additive, not a replacement).

## Decisions

**Decision 1 — The sidecar emits `user_prompt`, run-scoped, at the input push site.**
The sidecar already has the exact text and owns the `seq` space. The runner emits a `user_prompt` envelope
immediately **before** each `PushableInput.push(userMessage(...))`: in `startRun` (initial prompt) and in
`sendMessage` (each follow-up). Ordering before the push guarantees the prompt's `seq` precedes any SDK output
it triggers. The `Normalizer` mints the envelope (it owns `++this.seq` and the `ctx.requestedBy` attribution
already used for `run_started`/`run_interrupted`), keeping it the single seq-and-actor authority.
- *Alternative considered:* Rails appends it in `Runs::Start`/messages. Rejected — Rails has no collision-free
  run `seq` (every positive integer belongs to the sidecar), and pre-allocating ranges or a shared generator is
  far heavier than the problem.
- *Alternative considered:* reuse `chat_message` (session-scoped, no contract change). Rejected — it would not
  interleave by run `seq`, isn't tied to the run, and conflates "talking to humans" with "instructing Claude."

**Decision 2 — `user_prompt` ordering vs `run_started` on the initial prompt.**
On a fresh run the initial-prompt `user_prompt` is emitted in `startRun` before the query is driven, so it
takes **seq 1** and `run_started` (the SDK's init message) becomes **seq 2** — the prompt reads first, then
"run started", then Claude's output. This is intentional and matches the chosen feed preview. The normalizer's
monotonic counter makes this automatic as long as the runner emits the prompt before driving the query.

**Decision 3 — Payload is minimal: `{ text: string }`.**
Mirrors `AiTextPayload` shape minus `block` (a user prompt is not a Claude content block). Attribution lives in
the envelope `actor` (`{ kind: "user", id: requested_by }`), not the payload — consistent with how every other
user-attributed event works. No truncation cap in the contract (prompts are human-sized); the existing ai_raw
8KB cap does not apply since this is a first-class typed event.

**Decision 4 — Rails consumes with zero new logic.**
`Events::Ingest` already persists any run-scoped durable event verbatim keyed by `(ai_run_id, seq)` and
broadcasts it; `Runs::Finalize` switches only on lifecycle types and ignores `user_prompt`. So Rails needs no
code change beyond the shared contracts package version — only test coverage asserting ingest persists it.

**Decision 5 — Web renders inline via a dedicated `feed/user_prompt_block.tsx`.**
`activity_feed.tsx` adds a `case "user_prompt"` → `<UserPromptBlock>`, rendered in the same `seq`-ordered
durable list as everything else, styled distinctly from Claude's `ai_text` (participant-attributed, light
treatment consistent with the refreshed run banner). No store change — `user_prompt` is a normal durable event
already deduped by `id`.

## Risks / Trade-offs

- **A consumer pinned to an exact `minor` would reject `1.2`.** → The frozen rule is exact `major` + `minor >=`
  *needed*; no consumer pins an exact minor. Verified live across the `1.0 → 1.1` bump (Rails `ContractVersion`
  stayed green). The `EVENT_TYPE_COUNT` guard (`20 → 21`) is updated in lockstep so the compile-time freeze
  check passes.
- **An old web build receiving a `user_prompt` it doesn't know.** → The envelope contract guarantees unknown
  `type`s degrade safely; the feed's `default` branch already routes unmapped durable types to `RawFallback`,
  so a stale client shows it as raw rather than crashing.
- **Double-emit / wrong ordering if emitted after the push.** → Emit strictly before `PushableInput.push`, and
  unit-test that on a fresh run `user_prompt` carries `seq 1` and precedes `run_started`, and that a follow-up
  emits exactly one `user_prompt` before the pushed message.
- **Interrupt/early-failure edge:** a follow-up pushed to a run that errors. → `user_prompt` is durable and
  independent of the run's terminal state; it persists and renders regardless, which is the desired transcript
  behavior.

## Migration Plan

Additive, no data migration. Order: (1) contracts package (`user_prompt` + `UserPromptPayload` + version bump
+ guard) so both sides compile against it; (2) sidecar emit + tests; (3) web render + test; (4) docs
(`events.md`, `sdk_mapping.md`, `CHANGELOG.md`). No backfill — pre-existing runs simply have no `user_prompt`
events (the feed renders them exactly as it does today). Rollback = revert the four edits; the `minor` bump
reverts with them and no persisted data depends on it.

## Open Questions

None blocking. Visual styling of the prompt block (alignment/color) is a presentation detail finalized during
implementation against the refreshed feed look; it does not affect the contract or emit behavior.
