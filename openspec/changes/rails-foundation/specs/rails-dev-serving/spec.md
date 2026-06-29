## ADDED Requirements

### Requirement: Rails fronts the SPA and proxies Vite HMR in development on the single published port

In development, Rails SHALL serve `/api` and `/~cable` itself and SHALL reverse-proxy all OTHER requests — the SPA, its static assets, and the Vite HMR WebSocket upgrade — to the unpublished `vite` service over the compose network, so the browser reaches everything through the single published `rails:3000` port and never needs to reach `5173` directly. In production-style serving, Rails SHALL serve the built SPA directly (no proxy). The reverse-proxy is the Rails-side counterpart to the Vite-side HMR configuration: the compose wiring (the unpublished `vite` service, the single published `rails` port) is owned by the `dev-docker-compose` change, and the Vite-side HMR config (`server.host: true`, `server.hmr.clientPort: 3000`, `server.watch.usePolling`) is owned by the `web-scaffold` change; this requirement owns only the Rails-side middleware that fronts and proxies them.

#### Scenario: LAN browser gets the dev SPA and a working HMR websocket through the rails port

- **WHEN** a LAN browser loads `http://<host>.local:3000` in development
- **THEN** Rails serves the SPA and reverse-proxies it (and the Vite HMR WebSocket upgrade) to the unpublished `vite` service, so the browser receives the SPA and a working HMR websocket through the single published `rails:3000` port without reaching `5173`

#### Scenario: Production-style serving serves the built SPA directly

- **WHEN** the app runs in production-style serving
- **THEN** Rails serves the built SPA directly and does NOT reverse-proxy to `vite`

#### Scenario: Vite upstream unreachable yields a clear 502 while /api and /~cable keep working

- **WHEN** the `vite` upstream is unreachable while Rails reverse-proxies a non-`/api` request to it in development
- **THEN** Rails returns a clear `502`/Bad Gateway (or equivalent) for the SPA request, while `/api` and `/~cable` served directly by Rails continue to work

### Requirement: Host authorization and cable origins allow LAN access

Rails SHALL set `config.hosts` to allow `<host>.local` and the host's LAN IP, and SHALL configure ActionCable allowed origins to permit the `.local` host and the LAN IP, so that cross-machine LAN access is not blocked by `HostAuthorization` or the ActionCable origin check. Without this, publishing port `3000` to the LAN would leave Rails silently rejecting `<host>.local` requests and cable connections.

#### Scenario: A request with a .local Host header is allowed

- **WHEN** a request arrives with a `Host` header of `<host>.local`
- **THEN** it is allowed by `HostAuthorization` (not blocked) because `config.hosts` permits `<host>.local` and the LAN IP

#### Scenario: A cable connection from a .local origin is allowed

- **WHEN** an ActionCable connection is opened with an `Origin` of the `.local` host or the LAN IP
- **THEN** the connection is not rejected by the ActionCable allowed-origins check
