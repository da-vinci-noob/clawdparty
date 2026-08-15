# sidecar

Node + Fastify service wrapping `@anthropic-ai/claude-agent-sdk`. The **only**
code in the repo that knows the SDK exists. It normalizes every SDK message into
a Contract-1 event envelope (`normalizer.ts` is the sole SDK-aware file) and
POSTs batches to Rails at `/internal/events`.

- Unpublished on the compose network as `http://sidecar:8787` (only `rails`
  publishes a port). Reaches Rails via `RAILS_INTERNAL_URL` (distinct from the
  Rails→sidecar `SIDECAR_URL`).
- Files: `index.ts` (server + heartbeat + SIGTERM flush), `normalizer.ts`
  (SDK→envelope, never-crash `ai_raw`, redact-then-truncate), `transport.ts`
  (batched/idempotent POST + ring buffer + retry classification),
  `permissions.ts` (`canUseTool` allow-all seam), `config.ts`.

## Claude authentication — the host's existing login (no app-owned credential)

The sidecar owns **no** Anthropic credential and selects **no** auth method. The
SDK auto-detects from the inherited host environment (direct API key, Claude
subscription/enterprise OAuth, or Amazon Bedrock). The bind-mount + env-passthrough
wiring is owned by the `dev-docker-compose` change.

Two host-side caveats the container cannot solve in code:

- **macOS subscription/enterprise OAuth** lives in the **Keychain with no file**,
  invisible to the Linux container. Run `claude setup-token` once on the host and
  export `CLAUDE_CODE_OAUTH_TOKEN` so the sidecar inherits a usable token.
- **Bedrock via AWS SSO** tokens **expire**. Keep the host `aws sso login`-fresh —
  the read-only `~/.aws` mount reflects the refreshed token, but the container
  cannot refresh it itself.

## Commands

```sh
npm run start      # tsx src/index.ts (Fastify on :8787)
npm run typecheck  # tsc --noEmit
npm run lint       # biome check .
npm run test       # vitest run
```

The five gate suites mandated by the project rules run individually
so a single gate can be exercised without the whole suite:

```sh
npm run test:crash               # crash-injection (recovery from every phase)
npm run test:reconstruction      # request-reconstruction (byte-identical replay)
npm run test:adapters            # provider adapter conformance
npm run test:extensions          # extension-point contract
npm run test:plugin-adversarial  # third-party plugin isolation
```

## Dependencies — what each one is for

The harness migration adds provider
SDKs ahead of the adapters that use them, so the install is settled once rather
than per-milestone. Each is scoped:

| package | scope |
|---|---|
| `@anthropic-ai/sdk` | The Messages API client. The loop we own is built on this. |
| `@anthropic-ai/bedrock-sdk` | Bedrock only, via the **Mantle** client (`AnthropicBedrockMantle`) — not a `base_url` override of the direct client. |
| `@aws-sdk/client-bedrock` | Bedrock **model discovery** only (already present, reused). Not an inference path. |
| `better-sqlite3` | The harness-owned durable store (`src/store/`). Synchronous by design — the store's commit is on the critical path and must not interleave. |
| `openai` | **M3 /  Codex adapter ONLY.** Nothing outside `src/providers/codex*.ts` may import it. |
| `@anthropic-ai/claude-agent-sdk` | **Being removed.** Pinned until the loop takes over; deleted when it does. Any new import of it is a regression. |

## Week-1 scope

Skeleton: run-control routes are `501` stubs (wired to the runner in W2); the
normalizer commits only the never-crash `ai_raw` rule + ephemeral classification
(the full per-type mapping table is **pending-spike**). See
`test/fixtures/README.md`.
