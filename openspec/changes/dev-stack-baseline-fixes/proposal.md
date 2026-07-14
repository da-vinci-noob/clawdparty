## Why

`bin/start` cannot bring the dev stack up as it stands, and browser development has no working hot
reload. Both `sidecar/` and `web/` declare `"@clawdparty/contracts": "file:../packages/contracts"`,
but the compose services bind-mount only their own dir (`./sidecar:/app`, `./web:/app`) — so inside
the container `../packages/contracts` resolves to `/packages/contracts`, which is not mounted, and the
entrypoint `npm ci` fails. Separately, `DevSpaProxy` forwards with `Net::HTTP`, which cannot tunnel a
WebSocket upgrade, so Vite's HMR ws (pointed at the published `rails:3000` port via
`hmr.clientPort: 3000`) never reaches `vite:5173`. These are the baseline blockers for every
browser-facing Week-2 track; fix them before relying on the stack.

## What Changes

- Mount `./packages:/packages:ro` into the `sidecar` and `vite` services so the `file:` contracts
  dependency resolves at `npm ci` time (read-only — consumers only import the TS source).
- Implement WebSocket-upgrade tunneling in `DevSpaProxy`: detect `Upgrade: websocket` requests and
  tunnel the socket to the `vite` upstream via `rack.hijack`, so HMR survives the single-published-port
  hop. Non-upgrade requests keep the existing `Net::HTTP` path; `/api` and `/~cable` stay Rails-owned.
- Verify `bin/start` from a clean volume and the HMR ws end-to-end (documented procedure).

## Capabilities

### New Capabilities
- `dev-hmr-proxy`: the Rails-side reverse-proxy behavior for the Vite dev server, including the
  WebSocket-upgrade tunnel to the unpublished `vite` service over the single published port.

### Modified Capabilities
<!-- None at the spec level. The compose stack / credential-mount capabilities from dev-docker-compose
     gain a package mount, but their frozen requirements (only rails publishes a port; credential
     mounts read-only; sidecar/vite unpublished) are unchanged — the new mount is read-only source,
     not a port or credential. -->

## Impact

- **Compose:** `docker-compose.yml` — two added read-only volume lines (`sidecar`, `vite`). No new
  published ports; the "only `rails` publishes" invariant is preserved.
- **Rails (dev only):** `api/app/middleware/dev_spa_proxy.rb` gains ws-tunnel handling; the middleware
  is a no-op in production (built SPA served directly). New/extended request spec.
- **Consumes (unchanged):** the `compose-stack`, `compose-networking`, `claude-credential-mounts`
  capabilities (`dev-docker-compose`) and the Vite-side HMR config (`web-scaffold`, `hmr.clientPort`).
- **Enables:** browser dev for `web-cable-reducer`, `web-activity-feed`, and all later web tracks.
- **Out of scope:** no application features, no sidecar/SDK work, no contract changes.
