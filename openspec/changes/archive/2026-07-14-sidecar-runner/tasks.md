> **SDK-spike-gated:** the normalizer full coverage (§3) + the raw-fixtures cross-check (§3.5) require
> `sdk-message-spike` to have landed the real mapping + `raw_run.jsonl` + `sample_run.jsonl`. The run-loop
> structure (§1–§2) is spike-independent. Apply this change AFTER `sdk-message-spike`.

## 1. Run loop (sidecar-run-loop)

- [x] 1.1 Implement `sidecar/src/runner.ts`: accept `POST /runs` → start `query()` with `cwd` = worktree (`repo_path`), `permission_mode: acceptEdits`, `allowed_tools`, optional `claude_session_id`; replace the `501` with `202 { run_id, status: "running" }` (signature unchanged)
- [x] 1.2 Track the single active run (run id + query handle + pushable input + per-run normalizer instance); a second `POST /runs` → `409`
- [x] 1.3 Emit `run_started` with `actor = { kind: "user", id: requested_by }`; scope per-run `seq` to this run (never carried across runs)
- [x] 1.4 `index.ts` handlers stay thin — parse + delegate to `runner.ts`; all SDK interaction in the runner, all SDK-shape interaction in `normalizer.ts`
- [x] 1.5 `/healthz` + heartbeat report the real `active_run_ids`

## 2. Streaming input + interrupt (sidecar-run-loop)

- [x] 2.1 `POST /runs/:id/messages`: push the follow-up into the live streaming-input iterable (no respawn) → `200 { run_id, accepted: true }`; carry `requested_by` onto follow-up-driven events; reject follow-up to unknown/terminal run (`404`/`409`)
- [x] 2.2 `POST /runs/:id/interrupt`: call SDK `interrupt()`, emit `run_interrupted` with `actor = { kind: "user", id: requested_by }` (NOT system) → `200 { run_id, accepted: true }`
- [x] 2.3 Emit `run_finished`/`run_failed` (system-attributed) as the run concludes; NEVER finalize run state (Rails does)

## 3. Normalizer full coverage (sidecar-normalizer-full) — SPIKE-GATED

- [x] 3.1 Replace the `pending-spike` mapping in `normalizer.ts` with the `sdk-message-spike` per-type mapping: deltas (ephemeral/~150ms coalesced) + durable `ai_text` on block-stop, thinking, tool start/finish/fail, terminal output, file changes, result
- [x] 3.2 Tool input summarized (path/command/~500 chars, never full Edit/Write); `terminal_output` ~64KB chunks; `run_finished` carries `total_cost_usd` + `usage`
- [x] 3.3 Keep never-crash unknown→`ai_raw` + redact-then-truncate for anything the mapping does not cover
- [x] 3.4 Confirm `normalizer.ts` stays the ONLY SDK-shape-aware file (runner/index/transport see only envelopes)
- [x] 3.5 Cross-check test: `raw_run.jsonl` through the normalizer equals `packages/contracts/fixtures/sample_run.jsonl`; drift fails (the unblocked `sidecar-normalizer-v1` task 5.4)

## 4. Tests

- [x] 4.1 Run-loop unit tests with a mocked `query()` (scripted messages): start → 202, second start → 409, lifecycle events emitted, no run-state finalization
- [x] 4.2 Streaming-input test: follow-up pushed into the live iterable; follow-up after completion rejected
- [x] 4.3 Interrupt test: `interrupt()` called, `run_interrupted` user-attributed to `requested_by`
- [x] 4.4 Normalizer mapping tests (per-type) + the raw-fixtures cross-check (§3.5)
- [x] 4.5 (Optional, host-auth-gated) one live `query()` smoke — NOT a CI dependency
- [x] 4.6 Confirm `sidecar` checks stay green: Biome + tsc + Vitest (Node 24)

## 5. Validation

- [x] 5.1 Run `openspec validate sidecar-runner --type change --strict` and confirm valid
- [x] 5.2 Integration check: with `run-orchestration` up, a Rails `POST /runs` drives a live run whose events flow through transport to `/internal/events` and a subscribed browser sees them (the W2 watchable milestone)
