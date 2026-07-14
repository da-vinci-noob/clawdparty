## Why

The `sidecar/` stream is the **only** code that knows the `@anthropic-ai/claude-agent-sdk` exists, and every live event the rest of the system renders flows out of it. Before the full run lifecycle can be built in Week 2, the Week-1 milestone (`docs/PLAN.md §10`/§15) requires that **Rails + sidecar can replay the fixture end-to-end** — which needs a real HTTP server that Rails can reach, a normalizer that turns SDK shapes into Contract-1 envelopes (and never crashes on unknown ones), and a transport that POSTs those envelopes to Rails idempotently and survives Rails being down. This change builds that skeleton in the sidecar stream (the "sidecar skeleton: HTTP server, normalizer v1, event POST to Rails" item in `docs/PLAN.md §10`) and consumes the now-frozen `event-envelope` and `sidecar-protocol` capabilities rather than re-deriving them.

## What Changes

- Create `sidecar/` as a Node 24 + TypeScript + Fastify package with Biome + `tsc` + Vitest tooling, and add the CI `sidecar` job (Biome + `tsc` + Vitest), **pinned to Node 24** (the host runs Node 25 — pin to avoid drift).
- Create `sidecar/src/index.ts`: the Fastify server on port **8787, unpublished** (compose-network only, reachable as `http://sidecar:8787`), plus a 5s heartbeat to Rails. Route **stubs** for `POST /runs`, `POST /runs/:id/messages`, `POST /runs/:id/interrupt`, and a working `GET /healthz` returning `active_run_ids`. The three run routes are skeletons wired to the runner in Week 2.
- Create `sidecar/src/normalizer.ts` (**v1**): the only file that touches raw SDK message shapes. v1 rule — any unknown/unmapped SDK message type is emitted as an `ai_raw` event, **never a crash**. Output is the Contract-1 envelope (per `event-envelope`). The full per-type mapping table is **spike-gated** (finalized after the Tuesday SDK spike) and marked pending-spike here.
- Create `sidecar/src/transport.ts`: batched + idempotent + retry-with-backoff POST to Rails `POST /internal/events` (bearer `SIDECAR_SHARED_SECRET`), ring-buffering events when Rails is down and retrying (idempotent ingest on `(ai_run_id, seq)` makes replay safe). Rails callback base URL is configurable.
- Create `sidecar/src/permissions.ts`: `canUseTool` **allow-all stub** for the MVP — the documented seam for later per-tool Bash gating.
- Own the **raw SDK message fixtures** under `sidecar/` (input to normalizer tests) — distinct from `packages/contracts/fixtures/sample_run.jsonl`, which is the normalized output owned by `freeze-interface-contracts`.
- Establish **Claude auth passthrough**: the sidecar relies on the host developer's existing Claude login (any of API key, subscription/enterprise OAuth, or Amazon Bedrock) and contains **no app-owned credential and no method-selection code** — the SDK auto-detects in its own precedence order. (The actual bind-mount/env wiring is implemented in the `dev-docker-compose` change; this change owns the no-credential-in-code requirement and documents the two host caveats.)

**Explicitly out of Week-1 scope (Week 2+):** the `runner.ts` run lifecycle/state machine, worktree creation (Rails owns it), real run execution, interrupt/streaming-input behavior beyond route stubs, and `hooks.ts` (Bash→`terminal_output`, Edit/Write→`file_changed`) / full normalizer per-type coverage. The run routes here are stubs only.

## Capabilities

### New Capabilities
- `sidecar-runtime`: The Fastify HTTP server (Node 24/TS), the run-route stubs + working `GET /healthz`, the 5s heartbeat, the unpublished `:8787` binding (compose-network only), and configuration: `SIDECAR_URL` is the frozen Rails→sidecar address, while the sidecar→Rails callback base URL is a distinct variable (`RAILS_INTERNAL_URL`) — the two directions are not conflated. Tooling: Biome + `tsc` + Vitest and the pinned-Node CI `sidecar` job.
- `sidecar-normalizer-v1`: The single SDK-aware file. v1 never-crash rule (unknown SDK type → `ai_raw`), output as Contract-1 envelopes, raw-SDK fixtures owned here, and the full per-type mapping table marked pending-spike.
- `sidecar-transport`: Batched/idempotent/retry-with-backoff POST to `/internal/events`, ring-buffer while Rails is down, bearer-auth with `SIDECAR_SHARED_SECRET`, configurable Rails base URL.
- `claude-auth-passthrough`: Auth-method-agnostic reliance on the host's existing Claude login with no app-owned key and no credential-selection code, plus the two documented host caveats (macOS Keychain OAuth, Bedrock-SSO token expiry).

### Modified Capabilities
<!-- None — this is a greenfield repo with no existing specs. This change CONSUMES the frozen event-envelope and sidecar-protocol capabilities (from freeze-interface-contracts) without modifying them. -->

## Impact

- **New files:** `sidecar/` package (`package.json`, `tsconfig.json`, Biome config, `vitest.config.ts`), `sidecar/src/{index,normalizer,transport,permissions}.ts`, normalizer unit tests + raw-SDK fixtures under `sidecar/`; the GitHub Actions `sidecar` CI job (Node 24).
- **Consumes (does not modify):** `event-envelope` (envelope shape, `ai_raw` fallback, `(ai_run_id, seq)` idempotency, ephemeral `ai_text_delta`) and `sidecar-protocol` (endpoint signatures, `POST /internal/events` + heartbeat shapes, `SIDECAR_URL`, bearer auth) — both frozen by `freeze-interface-contracts`.
- **Cross-stream dependency:** the Week-1 fixture-replay milestone needs this skeleton plus `rails-foundation`'s `Events::Ingest`/`/internal/events`; the normalizer's normalized output must match `packages/contracts/fixtures/sample_run.jsonl`.
- **Deferred wiring:** the read-only `~/.claude` + `~/.aws` bind-mounts and host auth env passthrough land in `dev-docker-compose`; this change only requires the sidecar carry no app-owned credential or selection logic.
- **No full run behavior yet** — the run routes are stubs; live Claude execution is Week 2.

## Dependencies

- **Hard prerequisite: `freeze-interface-contracts`.** This change CONSUMES the frozen `event-envelope` capability (envelope shape, the type names + `ai_raw` fallback, `(ai_run_id, seq)` idempotency, ephemeral `ai_text_delta`/`presence_changed`) and the frozen `sidecar-protocol` capability (endpoint signatures both directions, `SIDECAR_URL`/callback addressing, bearer auth, the worktree/`base_sha` rule). The normalizer cross-check test also depends on `packages/contracts/fixtures/sample_run.jsonl`, which `freeze-interface-contracts` owns.
- **Apply ordering (explicit):** `freeze-interface-contracts` → `sidecar-foundation`. Do not apply this change before the contracts are frozen.
