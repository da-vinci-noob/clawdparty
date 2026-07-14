## ADDED Requirements

### Requirement: Only the rails service publishes a port

The `rails` service SHALL be the **only** service that publishes a port to the host/LAN, publishing `3000:3000`. Puma SHALL bind `0.0.0.0:3000` **inside** the container so the published port reaches it; the LAN exposure comes solely from that single published port.

#### Scenario: rails is reachable on the LAN

- **WHEN** the stack is up
- **THEN** the `rails` service publishes `3000:3000` and is reachable on the LAN, with Puma bound to `0.0.0.0:3000` inside the container

#### Scenario: No other service publishes a port

- **WHEN** the compose file is inspected
- **THEN** only `rails` publishes a port; `sidecar`, `vite`, `jobs`, and `postgres` do not publish ports to the host

### Requirement: sidecar and vite are unpublished (compose-network only)

The `sidecar` service (port `8787`) and the `vite` service (port `5173`) SHALL NOT publish their ports to the host/LAN; their ports SHALL be reachable only on the compose network — the Docker equivalent of loopback-only. To make this leak-proof, the `sidecar` and `vite` services SHALL NOT carry a `ports:` key at all — not even a loopback-bound form such as `ports: ["8787:8787"]` or `ports: ["127.0.0.1:8787:8787"]` — because any `ports:` entry publishes to the host. An `expose:` key is acceptable since it does not publish to the host.

#### Scenario: Sidecar port is not reachable from the host

- **WHEN** a process on the host attempts to reach the sidecar on `8787`
- **THEN** it cannot, because `8787` is not published — the sidecar is reachable only from within the compose network

#### Scenario: Vite port is not reachable from the host

- **WHEN** a process on the host attempts to reach Vite on `5173`
- **THEN** it cannot, because `5173` is not published — Vite is reachable only from within the compose network

#### Scenario: Neither sidecar nor vite carries a ports key

- **WHEN** the compose file is inspected
- **THEN** neither the `sidecar` nor the `vite` service has a `ports:` key (an `expose:` key is acceptable), so neither can accidentally publish to the host via `ports: ["8787:8787"]` or `ports: ["127.0.0.1:8787:8787"]`

### Requirement: Rails reaches the sidecar over compose DNS via configurable SIDECAR_URL

The `rails` service SHALL reach the `sidecar` service at `http://sidecar:8787` using the compose network's service-name DNS, and this address SHALL be supplied via a configurable `SIDECAR_URL` so no fixed host is hard-coded anywhere in the app. This keeps a future Tailscale/remote rebind a drop-in (change the address, no app change).

#### Scenario: Rails calls the sidecar by service name

- **WHEN** Rails needs to call the sidecar
- **THEN** it uses `SIDECAR_URL` (default `http://sidecar:8787`), resolving the `sidecar` service over compose DNS

#### Scenario: No fixed host is assumed

- **WHEN** the configuration is inspected
- **THEN** the sidecar address is supplied via `SIDECAR_URL` and is not a hard-coded `localhost`/fixed host, so a future remote rebind is a config change only

### Requirement: Sidecar reaches Rails over compose DNS via configurable RAILS_INTERNAL_URL

The `sidecar` service SHALL receive the Rails callback base URL as `RAILS_INTERNAL_URL` (default `http://rails:3000` over the compose network), distinct from `SIDECAR_URL`, so the sidecar→Rails direction (`POST /internal/events`, heartbeat) is configurable and no fixed host is hard-coded. The two directions SHALL NOT be conflated onto one variable.

#### Scenario: Sidecar posts events and heartbeats to Rails by service name

- **WHEN** the sidecar POSTs events or heartbeats to Rails
- **THEN** it uses `RAILS_INTERNAL_URL` set on the `sidecar` service, not a hard-coded host

### Requirement: rails fronts both API and the dev SPA on the single published port

The browser SHALL reach the application only through the single published `rails` port (`3000`) — including over the LAN — because `vite` is unpublished. In development, `rails` SHALL serve `/api` and `/~cable` itself and SHALL reverse-proxy all other requests (the SPA, its assets, and the Vite HMR WebSocket) to the `vite` service over the compose network. In production-style serving, `rails` serves the built SPA directly. This keeps the "only `rails` publishes a port" invariant intact while still delivering the dev SPA and HMR to LAN clients. The Rails dev reverse-proxy middleware is implemented by `rails-foundation`; the Vite side (binding to all interfaces and pinning the HMR client port to 3000 so the upgrade survives the proxy hop) is configured by `web-scaffold`.

#### Scenario: A LAN browser gets the dev SPA and HMR via the rails port

- **WHEN** a teammate's browser on the LAN loads `http://<host>.local:3000` in development
- **THEN** `rails` serves `/api` and `/~cable` directly and reverse-proxies the SPA and the HMR WebSocket to the unpublished `vite` service, so the browser never needs to reach `5173` itself

#### Scenario: vite remains unpublished

- **WHEN** the dev SPA is served to a LAN client
- **THEN** it is fronted entirely by the `rails` published port; `vite` publishes no port and is reached only by the rails reverse-proxy over the compose network

### Requirement: Target repo bind-mounted at a consistent path in both rails and sidecar

The target repository SHALL be bind-mounted at the **same absolute container path** in both the `rails` and `sidecar` services. That in-container path SHALL be the single constant `/repo` in both services. Because git worktrees record absolute `.git` paths, Rails (which creates worktrees at `<repo>/.clawdparty/worktrees/session-<id>`) and the sidecar (which uses each worktree as its `cwd`) must see the repository — and therefore the worktree gitdir — at an identical path. The host repo path MAY be configurable (via `TARGET_REPO_PATH`), but the in-container mount path SHALL be `/repo`, identical across the two services. The target-repo bind mount SHALL be **writable (read-write)** — unlike the `:ro` credential mounts (`~/.claude`, `~/.aws`) — because Claude edits files in the worktree `cwd` and a reject runs `git reset --hard HEAD && git clean -fd` in the worktree; both require a writable repo mount.

Because `rails` runs as root and `sidecar` runs as the non-root `node` user and **both** read-write the same bind-mounted repo and its git worktree metadata, the change SHALL ensure git operations do not fail on cross-uid ownership: `rails` (root) creates worktrees at `/repo/.clawdparty/worktrees/session-<id>` and writes their `.git` metadata, while the `sidecar` (`node` user) runs git in those worktrees as `cwd`, and Git 2.35.2+ rejects a repository whose directory owner differs from the running uid with "detected dubious ownership in repository". macOS Docker Desktop file-sharing usually masks this uid difference, but that is **not** guaranteed across OrbStack/Docker Desktop and breaks outright on any Linux host, so path-consistency alone is insufficient — ownership-consistency MUST also be guaranteed. The change SHALL guarantee it by configuring git `safe.directory` for `/repo` and the worktrees path (`/repo/.clawdparty/worktrees/*`) in the `sidecar` image — so git run by the `node` user does not reject a root-created worktree — OR by aligning the uid the two services run as. The `safe.directory` approach SHALL be preferred, because aligning the uids would break the `node`-home credential resolution (`~` → `/home/node`) that was deliberately chosen.

#### Scenario: A worktree created by rails resolves in the sidecar

- **WHEN** Rails creates a worktree at `<repo>/.clawdparty/worktrees/session-<id>` and the sidecar later uses it as `cwd`
- **THEN** the worktree's recorded absolute gitdir resolves correctly because the repo is mounted at the same container path in both services

#### Scenario: Mount path mismatch is prevented

- **WHEN** the compose file mounts the target repo into `rails` and `sidecar`
- **THEN** both use the identical in-container path `/repo` (even if the host path is configurable via `TARGET_REPO_PATH`), so absolute worktree gitdir paths never break across services

#### Scenario: Target repo is mounted read-write

- **WHEN** the `sidecar` and `rails` services mount the target repo
- **THEN** it is mounted read-write so Claude can edit the worktree and a reject can revert it with `git reset --hard HEAD && git clean -fd`, while `~/.claude` and `~/.aws` remain read-only

#### Scenario: Cross-uid git ownership does not fail in the sidecar

- **WHEN** the `node`-user `sidecar` runs git in a worktree created by the root `rails` service under `/repo/.clawdparty/worktrees/session-<id>`
- **THEN** git does not fail with "detected dubious ownership in repository" because the `sidecar` image configures `safe.directory` covering `/repo` and `/repo/.clawdparty/worktrees/*` (or the two services run as an aligned uid), so a root-created worktree is accepted by git run as the `node` user

### Requirement: Sidecar has an independent restart policy and is not a child of rails

The `sidecar` service SHALL have its own restart policy (e.g. `unless-stopped`) and SHALL NOT be a `depends_on` child of `rails`. A restart of the `rails` service SHALL NOT stop the `sidecar`; a crashed `sidecar` SHALL be rebooted by its own restart policy.

#### Scenario: Rails restart does not kill the sidecar

- **WHEN** the `rails` service restarts
- **THEN** the `sidecar` keeps running, because its lifecycle is independent and it is not a child of `rails`

#### Scenario: Crashed sidecar is rebooted

- **WHEN** the `sidecar` process crashes
- **THEN** its own restart policy reboots the container

### Requirement: Restart posture is declared for all five services

The compose file SHALL declare an explicit restart posture for **every** service so the long-lived host stack survives crashes and Mac sleep/wake without manual intervention. The posture per service SHALL be: `rails` — restart (`unless-stopped`) so the LAN-facing server recovers; `jobs` — restart (`unless-stopped`) so the Solid Queue supervisor recovers (also covering the restart-until-ready posture when the queue DB is not yet prepared); `postgres` — restart (`unless-stopped`) so the database recovers and data persists; `sidecar` — restart (`unless-stopped`), independent of `rails` (per the requirement above); `vite` — restart (`unless-stopped`) so the dev server recovers. Where a service intentionally does not restart, that "no restart by design" posture SHALL be stated explicitly rather than left to the Docker default.

#### Scenario: Every service has a stated restart posture

- **WHEN** the compose file is inspected
- **THEN** each of `rails`, `jobs`, `postgres`, `sidecar`, and `vite` has an explicit restart posture (e.g. `unless-stopped`, or an explicit "no restart by design"), so the stack survives crashes and Mac sleep/wake

### Requirement: Claude session JSONL survives container restarts via the host mount

Because `~/.claude` is bind-mounted from the host, the Claude session JSONL under `~/.claude/projects/` SHALL persist on the host across `sidecar` container restarts, so after a restart the host can resume a run via `claude_session_id`.

#### Scenario: Session JSONL persists across a sidecar restart

- **WHEN** the `sidecar` container restarts
- **THEN** the Claude session JSONL in the host's `~/.claude/projects/` is still present (it lives on the host), enabling `claude_session_id` resume
