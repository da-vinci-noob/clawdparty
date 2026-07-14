# web-dev-proxy Specification

## Purpose
TBD - created by archiving change web-scaffold. Update Purpose after archive.
## Requirements
### Requirement: Vite dev server reachable behind the rails reverse-proxy with working HMR

The browser/LAN entry point to the dev app SHALL be the single published `rails` port (`3000`), NOT the Vite port (`5173`); `5173` is unpublished (compose-network only) and its binding/networking invariant is owned and verified by the `dev-docker-compose` change (see that change's "rails fronts both API and the dev SPA on the single published port" requirement). In development, `rails` reverse-proxies the SPA, its assets, and the Vite HMR WebSocket to the `vite` service over the compose network; `web-scaffold` configures the Vite side so HMR survives that proxy hop.

The Vite dev configuration SHALL:

- bind the dev server to all interfaces (`server.host: true`) so the `rails` reverse-proxy can reach it over the compose network;
- configure the HMR client (`server.hmr.clientPort: 3000`) so the HMR WebSocket points at the `rails` published port the browser actually connects to — surviving the `rails`→`vite` proxy hop;
- still proxy `/api` and `/~cable` to the configured `rails` target (a configurable host / service name, NOT a hard-coded `localhost` literal) — this is a convenience for running Vite directly on the host (outside the compose stack) during development; `vite` is unpublished, so no host/LAN client can reach it directly. In the normal Docker flow the browser reaches everything through the `rails` reverse-proxy, so this Vite-side proxy is not on the primary path.

#### Scenario: HMR works when the SPA is served through the rails port

- **WHEN** the SPA is loaded via the published `rails` port (`3000`) in development
- **THEN** the HMR WebSocket connects on `clientPort` `3000` and hot updates are delivered to the browser through the `rails` reverse-proxy

#### Scenario: Dev server binds to all interfaces

- **WHEN** the Vite dev config is inspected
- **THEN** `server.host` is `true` so the `rails` reverse-proxy can reach the unpublished `vite` service over the compose network

#### Scenario: Vite still proxies API and cable for running Vite on the host

- **WHEN** the Vite dev config is inspected for non-asset requests (such as `/api`) and the `/~cable` WebSocket upgrade
- **THEN** the proxy is configured to forward them to the configured `rails` target (service name, not a hard-coded `localhost`) so a developer can run Vite directly on the host (outside the compose stack), with actual forwarding verified once `dev-docker-compose` + Rails are up

#### Scenario: Proxy target is configurable

- **WHEN** the Vite config is inspected
- **THEN** the proxy target is sourced from configuration (env var / service name), not a hard-coded `localhost` literal

### Requirement: Vite file-watch polling over the macOS bind mount

The Vite dev configuration SHALL enable file-watch polling (`server.watch.usePolling`) so that edits made on the macOS host bind mount propagate into the Linux container and trigger HMR. The setting SHALL be gated on the `VITE_USE_POLLING` environment variable, which `web-scaffold` reads in the Vite config; the `dev-docker-compose` change sets `VITE_USE_POLLING` on the `vite` service so polling is on by default inside the container and not forced on for non-container use.

#### Scenario: Host edits are detected via polling and trigger HMR

- **WHEN** a source file is edited on the macOS host bind mount while the dev server runs in the container
- **THEN** the change is detected via `server.watch.usePolling` and HMR updates the browser — exactly the kind of setup failure the W1 milestone is expected to catch

### Requirement: ActionCable WebSocket proxy at /~cable

The Vite dev configuration SHALL proxy the `/~cable` path as a WebSocket upgrade to the `rails` service, using the `/~cable` mount path for muscle memory (`docs/PLAN.md §16`). No ActionCable client SHALL be implemented in this change — only the proxy that a future `web/src/lib/cable.ts` will ride on (Week 2).

#### Scenario: /~cable upgrades as a WebSocket

- **WHEN** a WebSocket connection is opened to `/~cable` through the dev server
- **THEN** Vite proxies it as a WebSocket upgrade to the configured Rails target

#### Scenario: No cable client yet

- **WHEN** the scaffold is inspected
- **THEN** the `/~cable` proxy exists but no cable client (`web/src/lib/cable.ts`) is implemented

#### Scenario: Rails target unreachable degrades gracefully

- **WHEN** the `rails` proxy target is unreachable and a proxied `/api` request is made through the Vite dev server
- **THEN** the `/api` request fails as a connection error, the Vite dev server stays up, and HMR is unaffected

