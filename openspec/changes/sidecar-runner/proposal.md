## Why

`sidecar-foundation` shipped the sidecar skeleton: a Fastify server, the never-crash `ai_raw` normalizer v1,
the batched/ring-buffered transport, the heartbeat loop, and the `canUseTool` allow-all stub. But the
run-control routes (`POST /runs`, `/runs/:id/messages`, `/runs/:id/interrupt`) are **`501` stubs** — there is
no runner, so the sidecar never actually drives Claude. The frozen `sidecar-protocol` defines the success
shapes those routes must return in Week 2 (`202`/`200`); this change fills them in.

This is the **sidecar run-loop half of Week 2** (`docs/PLAN.md §10`, Shah Rukh: run lifecycle + normalizer full
coverage + interrupt + streaming follow-ups): the code that takes a `POST /runs` from Rails, runs a real
`@anthropic-ai/claude-agent-sdk` `query()` in the session worktree, normalizes every SDK message into Contract-1
envelopes via the **spike-derived mapping**, and streams them to Rails through the existing transport. It is the
B side that `run-orchestration` (the Rails A side) pairs with, and it consumes `sdk-message-spike`'s output —
so it is **spike-gated** and SHOULD be applied after the spike lands the real mapping + payload schemas.

## What Changes

- **`sidecar/src/runner.ts`** — the run lifecycle: accept a `POST /runs` (replace the `501` with the frozen
  `202 { run_id, status: "running" }`), start a `query()` with `cwd` pinned to the session worktree (`/repo/
  .clawdparty/worktrees/session-<id>`), `permission_mode: acceptEdits`, the `allowed_tools` whitelist, and the
  optional `claude_session_id` for resume. Drive the streaming-input iterable so follow-ups push in without
  respawning. Track active runs (one at a time; `409` on a second). Emit run-lifecycle events
  (`run_started`/`run_finished`/`run_failed`/`run_interrupted`) — but NEVER finalize run state (Rails does that).
- **Streaming input + follow-ups** — `POST /runs/:id/messages` pushes the follow-up text into the live run's
  pushable input iterable (`200 { run_id, accepted: true }`), carrying `requested_by` onto follow-up-driven
  events' actor.
- **Interrupt** — `POST /runs/:id/interrupt` calls the SDK `interrupt()` and emits a `run_interrupted` event
  attributed to the interrupting participant (`{ kind: "user", id: requested_by }`), per the frozen mapping
  (`200 { run_id, accepted: true }`).
- **Normalizer full coverage** — replace the `pending-spike` mapping table with the real per-type mapping from
  `sdk-message-spike`: text deltas (ephemeral, ~150ms coalesced) + durable `ai_text` on block-stop, thinking,
  tool start/finish/fail (tool-input summarized, never the full Edit/Write payload), terminal output (~64KB
  chunks), file changes, and the result event (carrying `total_cost_usd` + `usage`). The never-crash
  unknown→`ai_raw` rule and redact-then-truncate stay. Add the raw-fixtures-in → `sample_run.jsonl`-out
  cross-check test the spike unblocks.
- **Heartbeat carries real `active_run_ids`** — the loop now reports the actually-running run ids (was empty in
  the skeleton).
- **`/healthz` reports real active runs** — same.

This change does **not** create worktrees (Rails does, `run-orchestration`/`worktree-management`), does **not**
finalize run state (Rails does, `run-lifecycle`), and does **not** implement the changeset/diff (W3). It is the
sidecar runner + full normalizer only.

## Capabilities

### New Capabilities
- `sidecar-run-loop`: `runner.ts` — the run lifecycle (accept `/runs`, start `query()` with the worktree `cwd`
  + `acceptEdits` + `allowed_tools` + optional resume, one-active-run, emit lifecycle events without finalizing),
  streaming-input follow-ups, and SDK `interrupt()` with user-attributed `run_interrupted`. Replaces the
  `sidecar-runtime` `501` stubs with the frozen `202`/`200` success shapes, signatures unchanged.
- `sidecar-normalizer-full`: the spike-derived per-type mapping replacing `sidecar-normalizer-v1`'s
  `pending-spike` table — deltas (ephemeral/coalesced) + durable `ai_text`, thinking, tools (input summarized),
  terminal (chunked), file changes, result (cost/usage) — keeping never-crash `ai_raw` + redact-then-truncate,
  plus the raw-fixtures → `sample_run.jsonl` cross-check.

### Modified Capabilities
<!-- None as OpenSpec deltas: sidecar-foundation is not yet archived into openspec/specs/. This change ADDS the
     run loop + full normalizer on top of the frozen skeleton; the W1 `501`-stub and pending-spike-mapping
     requirements were explicitly framed as Week-2-fills, so this is additive realization, not a requirement change. -->

## Impact

- **New code:** `sidecar/src/runner.ts` (run lifecycle + streaming input + interrupt), the filled-in run-control
  handlers in `index.ts`, the full per-type mapping in `normalizer.ts`, active-run tracking feeding `/healthz` +
  heartbeat, and Vitest coverage incl. the raw-fixtures cross-check.
- **Consumes (does not modify):** the frozen `sidecar-protocol` (the `/runs` fields + `202`/`200`/`409` shapes,
  worktree `cwd`, `requested_by`), `event-envelope` (envelope, per-run `seq`, ephemeral rule, actor union),
  `sdk-message-spike` (the real mapping + payload schemas + `raw_run.jsonl` + `sample_run.jsonl`), and the W1
  transport (batched durable + fire-and-forget ephemeral) + `canUseTool` stub.
- **Cross-stream:** pairs with `run-orchestration` (Rails `POST /runs` caller + `Runs::Finalize` consuming the
  lifecycle events this runner emits). The two together make a live run watchable end-to-end.
- **SDK-spike-gated:** the normalizer full coverage + the `sample_run.jsonl` cross-check require
  `sdk-message-spike`'s output. The run-loop *structure* (accept/start/interrupt/streaming-input) is
  spike-independent, but the events it emits are only correct once the mapping is real, so this change SHOULD be
  applied after `sdk-message-spike`.
- **Runs live Claude:** exercising this end-to-end uses the host's inherited login (no app-owned credential),
  the same path the spike validated.
- **Dependencies:** `sidecar-foundation`, `freeze-interface-contracts`, `sdk-message-spike` (mapping/fixtures),
  and at runtime `run-orchestration` (the worktree + `POST /runs` caller).
