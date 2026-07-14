## 1. Scaffold the sidecar package and tooling

- [x] 1.1 Create `sidecar/` with `package.json` (Node 24 `engines`; pin the `@anthropic-ai/claude-agent-sdk` version) and `tsconfig.json` (strict TS: `strict`, `isolatedModules`)
- [x] 1.2 Add Biome config matching repo conventions (2-space, double quotes, semicolons, `noExplicitAny`, `useImportType`, `noConsole: error`) and a `vitest.config.ts`
- [x] 1.3 Create `sidecar/src/` and a `sidecar/fixtures/` (or `sidecar/test/fixtures/`) directory for raw SDK message fixtures
- [x] 1.4 Verify `tsc`, Biome, and Vitest all run clean on the empty scaffold

## 2. Fastify server, healthz, route stubs (sidecar-runtime)

- [x] 2.1 Implement `sidecar/src/index.ts`: Fastify server listening on port 8787, bound for the compose network (unpublished — reachable as `http://sidecar:8787`, not from the host/LAN)
- [x] 2.2 Implement `GET /healthz` returning `{ active_run_ids }` (empty in the skeleton; no auth required)
- [x] 2.3 Add stub handlers for `POST /runs`, `POST /runs/:id/messages`, `POST /runs/:id/interrupt` matching the `sidecar-protocol` signatures, returning an explicit not-yet-implemented response (no run execution; wired to the runner in Week 2)
- [x] 2.4 Read the sidecar→Rails callback base URL (`RAILS_INTERNAL_URL`, distinct from the Rails→sidecar `SIDECAR_URL`) and `SIDECAR_SHARED_SECRET` from configuration (env); assert no Rails host is hard-coded

## 3. Heartbeat (sidecar-runtime)

- [x] 3.1 Implement the 5-second `POST /internal/sidecar/heartbeat` loop carrying `active_run_ids` (empty in the skeleton), bearer-authed with `SIDECAR_SHARED_SECRET`
- [x] 3.2 Ensure the heartbeat loop keeps retrying on its cadence and never crashes the sidecar when Rails is unreachable
- [x] 3.3 Add a `SIGTERM` handler doing a best-effort transport-buffer flush (POST pending durable events to Rails) before exiting; do NOT finalize any run state (full graceful-drain is deferred to W3; Rails finalizes interrupted runs)

## 4. Normalizer v1 (sidecar-normalizer-v1)

- [x] 4.1 Implement `sidecar/src/normalizer.ts` as the ONLY SDK-aware file; emit Contract-1 envelopes (per the `event-envelope` capability)
- [x] 4.2 Implement the v1 never-crash rule: any unknown/unmapped/malformed SDK message → `ai_raw` event, never dropped, never thrown
- [x] 4.3 Assign per-run monotonic `seq` scoped to `ai_run_id`; never carry `seq` across runs
- [x] 4.4 Classify `ai_text_delta`/`presence_changed` as ephemeral and coalesce deltas (~150ms); emit durable `ai_text` on text-block stop (delta generation fully wired with the runner in Week 2)
- [x] 4.5 Mark the full per-type SDK mapping table explicitly `pending-spike` (do NOT invent it pre-spike)
- [x] 4.6 Track these PLAN obligations as `pending-spike` (gated on the Tuesday Week-1 SDK spike; do NOT implement pre-spike): (a) cost/usage — `total_cost_usd` + `usage` on the `run_finished`/result event; (b) tool-input summarization — `tool_started` inputs summarized to path/command/~500 chars, never the full Edit/Write payload; (c) `terminal_output` chunking — Bash output emitted in ~64KB chunks
- [x] 4.7 Stamp event `actor`: set `run_started.actor = { kind: "user", id: <requested_by> }` from the run-start payload's `requested_by`; set `run_interrupted.actor = { kind: "user", id: <requested_by> }` from the interrupt request body's `requested_by` (mirroring `run_started`, per the frozen `sidecar-protocol`); set `actor = { kind: "claude" }` on Claude-originated events
- [x] 4.8 Bound the `ai_raw` payload: redact values of credential-bearing keys (`api_key`/`token`/`secret`/`authorization`/password-like, case-insensitive) across the full serialized structure, THEN truncate to the 8KB cap stamping `truncated: true` when exceeded (redact-then-truncate ordering); never log the `SIDECAR_SHARED_SECRET` or any auth token (additive safety hardening — CHANGELOG-worthy, not a contract change)

## 5. Raw-SDK fixtures and normalizer tests (sidecar-normalizer-v1)

- [x] 5.1 Capture/check in raw SDK message fixtures under `sidecar/` (input to normalizer tests) — distinct from `packages/contracts/fixtures/sample_run.jsonl`
- [x] 5.2 Write a Vitest normalizer test: an unknown/malformed SDK message yields `ai_raw` and does not throw
- [x] 5.3a Write a Vitest normalizer test for `ai_raw` bounding/redaction: a credential-like field (e.g. `api_key`/`token`/`secret`/`authorization`) in an unknown SDK message is redacted in the emitted `ai_raw` payload, and an oversized payload is truncated to the 8KB cap with `truncated: true` (assert redact-then-truncate ordering — the credential is redacted even when the value straddles the cap boundary)
- [x] 5.3 Pre-spike: write Vitest normalizer tests covering only the committed v1 behavior — never-crash unknown→`ai_raw` (in addition to 5.2) and the ephemeral-vs-durable classification (`ai_text_delta`/`presence_changed` ephemeral, `ai_text` durable). Do NOT assert the full fixture cross-check yet.
- [ ] 5.4 Post-spike (gated on Tuesday Week-1 SDK spike landing the per-type mapping table): write the Vitest normalizer test asserting raw-fixtures-in → Contract-1-envelopes-out equals `packages/contracts/fixtures/sample_run.jsonl` (full cross-check of the two fixture sets; drift fails CI). This task is blocked until the post-spike mapping table is in place.  — *SPIKE-BLOCKED: cannot run pre-spike (no per-type mapping / raw fixtures yet); placeholder dir + cross-check plan in `test/fixtures/README.md`*

## 6. Transport (sidecar-transport)

- [x] 6.1 Implement `sidecar/src/transport.ts`: batch durable Contract-1 events and POST to `/internal/events` with the `SIDECAR_SHARED_SECRET` bearer token
- [x] 6.2 Exclude ephemeral `ai_text_delta`/`presence_changed` from the durable batch
- [x] 6.3 Implement the in-memory ring buffer + retry-with-backoff on POST failure (Rails down / 5xx / network); drain on recovery; keep the sidecar running throughout
- [x] 6.4 Make the Rails base URL configurable so it can target a stub/log sink before `rails-foundation` lands `/internal/events`
- [x] 6.5 Write a Vitest test: a failed POST buffers and retries idempotently; recovery drains the buffer

## 7. Permissions and Claude-auth passthrough (claude-auth-passthrough)

- [x] 7.1 Implement `sidecar/src/permissions.ts`: `canUseTool` allow-all stub, documented as the per-tool Bash-gating seam; introduce no shell input path
- [x] 7.2 Confirm the sidecar contains no app-owned Anthropic key and no credential/method-selection code — auth is wholly inherited from the host environment (SDK auto-detects)
- [x] 7.3 Document the two host auth caveats (macOS Keychain OAuth → `claude setup-token` + `CLAUDE_CODE_OAUTH_TOKEN`; Bedrock-SSO token expiry → stay `aws sso login`-fresh). Note the bind-mount/env wiring is owned by `dev-docker-compose`

## 8. CI and validation

- [x] 8.1 Add the GitHub Actions `sidecar` job running Biome + `tsc` + Vitest, pinned to Node 24
- [x] 8.2 Confirm the full `sidecar` CI job passes green locally and in CI
- [x] 8.3 Verify against the W1 milestone: Rails can reach the sidecar, the heartbeat loop runs, and normalized events flow through transport to `/internal/events` (or a stub sink) end-to-end
