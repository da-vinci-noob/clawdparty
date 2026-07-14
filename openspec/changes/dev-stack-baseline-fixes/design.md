## Context

The dev stack is Docker Compose, one process per container, with only `rails` publishing a port;
`sidecar` and `vite` are unpublished and reached over the compose network. `rails` reverse-proxies the
SPA and — by design (see the `web/vite.config.ts` header and CLAUDE.md) — the Vite HMR WebSocket to
`vite:5173`. Two gaps block this today: the contracts `file:` dependency has no mount, and the proxy
middleware never implemented the ws upgrade path.

## Goals / Non-Goals

**Goals:**
- `bin/start` boots `sidecar` and `vite` from a clean volume (contracts dep resolves).
- HMR hot updates work in the browser through `rails:3000`.
- Preserve every `dev-docker-compose` invariant (only rails publishes; credential mounts read-only;
  sidecar/vite unpublished).

**Non-Goals:**
- Production serving (this middleware is a dev-only no-op in prod).
- Publishing `vite:5173` to the host (rejected — see Decisions).
- Any application, sidecar, or contract change.

## Decisions

**1. Mount `./packages:/packages:ro` (read-only).** npm resolves `file:../packages/contracts` from
`/app` to `/packages/contracts`; with npm's default `install-links=false`, a directory `file:` dep is
symlinked into the writable named-volume `node_modules`, so the source mount only needs to be readable.
Read-only matches the credential-mount safety posture and guarantees the container never mutates the
host package source. Alternative (copying `packages/` into each image) rejected: it duplicates source,
breaks the bind-mount live-edit model, and drifts from the host copy.

**2. Tunnel the HMR ws in `DevSpaProxy` via `rack.hijack`, keep `Net::HTTP` for everything else.**
`Net::HTTP` completes a request/response and cannot hand back a raw upgraded socket, so a ws upgrade
must bypass it. On an `Upgrade: websocket` request to a non-Rails path, hijack the client socket, open
a `TCPSocket` to the vite upstream, replay the handshake request line + headers, then pump bytes
bidirectionally until either side closes. `/api` and `/~cable` remain Rails-owned and are never
tunneled. Alternative (publish `vite:5173` and point `hmr.clientPort` at it) rejected: it violates the
single-published-port invariant and the documented design that Rails proxies the HMR ws.

**3. Host header is forwarded unchanged** (as the existing `Net::HTTP` path already does). Vite's
`allowedHosts` includes `vite`, `.local`, and `localhost`, which covers the compose service name and
LAN `<host>.local` origins; no rewrite is needed.

## Risks / Trade-offs

- [The ws-hijack tunnel is dev-infra socket code that cannot be unit-tested end-to-end without a live
  Puma + vite] → unit-test the routable logic (upgrade detection, Rails-owned passthrough, the
  non-hijackable-env fallback); mark the live HMR smoke as an explicit verification step run under
  `bin/start`. This change's author environment has no Docker daemon or Ruby toolchain, so the live
  paths are verified by the reviewer running the documented commands.
- [A leaked socket/thread per HMR connection would accumulate] → both pump directions close the
  sockets on EOF/error in an `ensure`; connections are dev-only and short-lived.
- [`npm ci` could still fail if the lockfile drifts from `packages/contracts`] → the fix only adds the
  missing mount; lockfile integrity is unchanged from the W1 CI-green state (CI resolves the same
  `file:` path because it checks out the whole repo).

## Migration Plan

Additive: two compose lines + a dev-only middleware branch. Rollback = revert; the stack returns to its
current (non-booting) state. No data migration. Verified via `bin/start` + an HMR edit smoke.

## Open Questions

- Whether Puma emits a warning on the hijacked-response return value — cosmetic; resolve during the
  live smoke and adjust the returned triplet if needed.
