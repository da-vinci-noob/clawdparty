## ADDED Requirements

### Requirement: Contracts package resolves inside sidecar and vite containers

The `sidecar` and `vite` services SHALL have the repository `packages/` directory mounted read-only at
`/packages` so that the `file:../packages/contracts` dependency in each service's `package.json`
resolves during the entrypoint `npm ci`. The mount SHALL be read-only and SHALL NOT publish any port
or alter the credential mounts.

#### Scenario: Clean-volume boot resolves the contracts dependency

- **WHEN** `bin/start` runs from empty named volumes
- **THEN** the `sidecar` and `vite` entrypoints complete `npm ci` with `@clawdparty/contracts` resolved
- **AND** no host package source is modified (the mount is read-only)

### Requirement: Rails proxies non-Rails requests to the Vite dev server

`DevSpaProxy` SHALL forward every request whose path is not Rails-owned (`/api`, `/~cable`, `/up`,
`/rails`, `/cable`) to the `vite` upstream, and SHALL return `502` with a plain-text body when the
upstream is unreachable. Rails-owned paths SHALL be handled by the downstream app and never proxied.

#### Scenario: Non-Rails path is proxied

- **WHEN** a request for `/index.html` arrives and the vite upstream is unreachable
- **THEN** the middleware returns `502` with a `Bad Gateway` body

#### Scenario: Rails-owned path is not proxied

- **WHEN** a request for `/api/...` or `/~cable` arrives
- **THEN** the downstream Rails app handles it and it is never forwarded to vite

### Requirement: HMR WebSocket upgrades are tunneled to the Vite upstream

For a non-Rails-owned request carrying `Upgrade: websocket`, `DevSpaProxy` SHALL tunnel the connection
to the vite upstream at the socket level (via `rack.hijack`) rather than forwarding it over
`Net::HTTP`, so the Vite HMR WebSocket survives the single-published-port hop. When the server does not
support `rack.hijack`, the middleware SHALL return a `502` rather than attempt an `Net::HTTP` forward
of an upgrade request.

#### Scenario: WebSocket upgrade is routed to the tunnel path

- **WHEN** a request for a non-Rails path arrives with `Upgrade: websocket`
- **THEN** the middleware attempts a socket-level tunnel to the vite upstream (not a `Net::HTTP` forward)

#### Scenario: Hijack unsupported

- **WHEN** an `Upgrade: websocket` request arrives and the server exposes no `rack.hijack`
- **THEN** the middleware returns `502` and does not attempt to forward the upgrade over `Net::HTTP`

#### Scenario: WebSocket upgrade on a Rails-owned path is not tunneled

- **WHEN** an `Upgrade: websocket` request targets `/~cable`
- **THEN** it is handled by the downstream Rails app (ActionCable), not tunneled to vite
