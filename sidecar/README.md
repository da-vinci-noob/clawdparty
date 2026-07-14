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

## Week-1 scope

Skeleton: run-control routes are `501` stubs (wired to the runner in W2); the
normalizer commits only the never-crash `ai_raw` rule + ephemeral classification
(the full per-type mapping table is **pending-spike**). See
`test/fixtures/README.md`.
