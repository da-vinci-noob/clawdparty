## Context

The sidecar skeleton (`sidecar-foundation`) deliberately stopped at structure: Fastify routes returning `501`,
normalizer v1 (never-crash `ai_raw` + redact-then-truncate, per-run `seq`, ephemeral classification, actor
stamping for run_started/run_interrupted), transport (batched durable + fire-and-forget ephemeral, ring buffer,
4xx-fatal classification), heartbeat (empty active set), `canUseTool` allow-all. Its specs explicitly framed
the `501`s as "W2 fills the handler bodies WITHOUT changing the signatures" and the per-type mapping as
`pending-spike`. This change is that fill.

It pairs with `run-orchestration`: Rails creates the worktree, records `base_sha`, and POSTs `/runs` with
`requested_by`, `repo_path` (the worktree), `permission_mode: acceptEdits`, `allowed_tools`, and optional
`claude_session_id`; this runner starts the SDK `query()` in that `cwd`. Rails finalizes run state from the
lifecycle events this runner emits — the runner NEVER transitions run state itself (`sidecar-runtime` rule).

It consumes `sdk-message-spike`: the real per-type mapping, payload schemas, and the `raw_run.jsonl` →
`sample_run.jsonl` fixture pair. The run-loop structure (accept/start/stream-input/interrupt/lifecycle events)
is spike-independent, but the *events' payloads* are only correct against the real mapping, so this change is
sequenced after the spike.

## Goals / Non-Goals

**Goals:**
- `runner.ts`: accept `/runs` (→ `202`), start `query()` with the worktree `cwd` + `acceptEdits` +
  `allowed_tools` + optional `claude_session_id`, one-active-run (→ `409` on a second), emit lifecycle events,
  never finalize run state.
- Streaming-input follow-ups via `/runs/:id/messages` (→ `200`) pushed into the live pushable iterable, no
  respawn; `requested_by` carried onto follow-up-driven events.
- Interrupt via `/runs/:id/interrupt` (→ `200`) calling SDK `interrupt()`, emitting user-attributed
  `run_interrupted`.
- Full normalizer per the spike mapping: ephemeral coalesced deltas + durable `ai_text`, thinking, tools
  (input summarized), terminal (chunked), file changes, result (cost/usage); never-crash `ai_raw` retained.
- `/healthz` + heartbeat report real `active_run_ids`.
- Vitest: run-loop unit tests (mocked SDK), interrupt attribution, follow-up streaming, and the raw-fixtures →
  `sample_run.jsonl` cross-check (the spike-unblocked drift test).

**Non-Goals:**
- Worktree creation / `base_sha` (Rails — `worktree-management`).
- Run-state finalization (Rails — `run-lifecycle`); the runner only emits events.
- The changeset/diff/approve/reject (W3).
- Sidecar supervision (container restart policy, SIGTERM graceful drain beyond the W1 best-effort flush, resume
  recovery) — W3 sidecar supervision.
- Per-tool Bash gating — `canUseTool` stays allow-all (the documented seam).

## Decisions

**1. `runner.ts` owns run lifecycle; `index.ts` handlers stay thin.** The Fastify handlers parse the request and
delegate to `runner.ts` (start/message/interrupt), returning the frozen shapes; all SDK interaction lives in the
runner, and all SDK *message shape* interaction lives in `normalizer.ts` (unchanged ownership rule). *Why:*
preserves "normalizer is the only SDK-shape-aware file" and keeps the server file transport/HTTP-only.

**2. One active run, tracked in-process; a second `/runs` is `409`.** The runner holds the active run (run id +
its `query()` handle + pushable input + the per-run normalizer instance). A `POST /runs` while one is active
returns `409` (frozen). *Why:* matches the Rails one-active-run invariant from the other side; the per-run
normalizer instance is what scopes `seq` to the run (resets per run, never carried across — frozen
`event-envelope`).

**3. Streaming input uses a pushable async iterable; follow-ups don't respawn.** `query()` is started with a
streaming-input iterable; `/runs/:id/messages` pushes the follow-up text into it. *Why:* frozen `sidecar-protocol`
("pushed into the live streaming-input iterable without respawning"). `requested_by` from the message body is
carried onto any follow-up-driven event's actor where applicable.

**4. Interrupt emits a user-attributed `run_interrupted`; Rails finalizes.** `/runs/:id/interrupt` calls SDK
`interrupt()` and emits `run_interrupted` with `actor = { kind: "user", id: requested_by }` (from the interrupt
body), per the frozen mapping — NOT `system`. The runner does NOT transition the run to `awaiting_review`; Rails
does (`run-lifecycle`). *Why:* interrupt is a human action (frozen `event-envelope` per-type table); the
sidecar-vs-Rails finalize boundary is a frozen `sidecar-runtime` rule.

**5. The normalizer mapping is the spike's output, not invented here.** This change imports the per-type mapping
and payload schemas finalized by `sdk-message-spike` and implements them: `ai_text_delta` ephemeral + ~150ms
coalesced (null id/seq) → durable `ai_text` on block-stop; thinking → `ai_thinking`; tool start/finish/fail with
**summarized** input (path/command/~500 chars, never the full Edit/Write payload); Bash output → `terminal_output`
in ~64KB chunks; file changes → `file_changed`; result → `run_finished` carrying `total_cost_usd` + `usage`.
Unknown/malformed → `ai_raw` (never-crash, redact-then-truncate) stays. *Why:* the spike is the source of truth;
inventing the mapping here would reintroduce the fiction the freeze forbids. *Gate:* if the spike hasn't landed,
this change blocks on it.

**6. The raw-fixtures cross-check is the contract-verification test.** A Vitest test feeds
`sidecar/test/fixtures/raw_run.jsonl` through the normalizer and asserts the output equals
`packages/contracts/fixtures/sample_run.jsonl` (drift fails CI), per `sidecar-normalizer-v1`'s deferred task
5.4. *Why:* this is the doubles-as-contract-verification test `docs/PLAN.md §13` calls for; it can only exist
once the spike lands both fixtures.

**7. Active-run tracking feeds `/healthz` + heartbeat.** The runner exposes the active run ids; `/healthz` and
the 5s heartbeat report them (was empty in the skeleton). *Why:* the frozen `sidecar-protocol` heartbeat carries
`active_run_ids`, and Rails' future stale-run reconciliation (`Sidecar::HealthcheckJob`, W2/W3) depends on
truthful reporting.

**8. Tests mock the SDK; one optional live smoke is gated on host auth.** Unit tests inject a fake `query()`
yielding scripted messages, so the run loop, interrupt attribution, follow-up streaming, and normalizer mapping
are deterministic and offline. A single end-to-end smoke (real `query()`) is optional and gated on host auth
(like the spike). *Why:* `docs/PLAN.md §13` scopes sidecar testing to normalizer units + the contract
cross-check; a live call must not be a CI dependency.

## Risks / Trade-offs

- **Spike-gated: the mapping is only correct against real SDK shapes.** *Mitigation:* sequenced after
  `sdk-message-spike`; the cross-check test fails if the mapping drifts from the captured fixtures; until the
  spike lands, this change blocks rather than guessing.
- **Delta floods.** 10–20k deltas/run. *Mitigation:* ~150ms coalescing (frozen), ephemeral fire-and-forget
  transport (no buffering), per-run `seq` only on durable events — all already in the W1 skeleton's contracts.
- **Tool-input leakage / bloat.** A full Edit/Write payload would leak content and bloat the durable store.
  *Mitigation:* summarization to path/command/~500 chars is pinned by the spike's payload schema and asserted in
  the normalizer test.
- **Interrupt races (interrupt arrives as the run is finishing).** *Mitigation:* the runner guards interrupt
  against the active-run handle; if no active run, `404`/`409` per the frozen shapes; Rails finalizes regardless.
- **One-active-run drift between sidecar and Rails.** Both enforce it. *Mitigation:* the sidecar `409` and the
  Rails partial index are independent backstops; the heartbeat's truthful `active_run_ids` lets Rails reconcile.
- **Streaming-input iterable lifecycle bugs (push after close).** *Mitigation:* follow-ups are rejected once the
  run is terminal (`404`/`409`); a unit test drives a follow-up after completion and asserts the rejection.

## Open Questions

- The exact SDK `query()` option names and the streaming-input/`interrupt()` API surface are taken from the
  pinned SDK version and the spike capture; if the spike reveals an API difference from the draft, it is an
  implementation detail resolved at apply time, not a contract change (the wire contract to Rails is frozen).
