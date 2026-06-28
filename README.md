# clawdparty

**Real-time collaborative Claude Code sessions in your browser.**

clawdparty turns a single Claude Code session into a shared room. Any number of developers join from their browser and watch Claude work live on a repo — streaming activity, file/diff viewers, a shared chat sidebar, and a human approval flow for every change Claude makes. One Mac hosts everything; **everyone, including the host, drives Claude through the web UI.** Nobody touches a terminal.

> **Status: early / greenfield.** The design is finalized in [`docs/PLAN.md`](docs/PLAN.md); the implementation is being built against it. The `api/`, `sidecar/`, and `web/` directories described below are the target layout and may not all exist yet. `docs/PLAN.md` is the source of truth.

## Why

Pairing on AI-assisted coding usually means one person screen-sharing while everyone else watches a video feed they can't interact with. clawdparty makes the session itself collaborative: the live Claude stream, the diffs, and the chat are all first-class, shared, and gap-free for late joiners — so a whole team can guide one Claude run and review its output together before anything is committed.

## Features

- **Watch Claude live** — streamed text, thinking, tool calls, and terminal output as they happen, in an activity feed built for high event volume.
- **Shared chat** — a per-session chat sidebar is the coordination backbone, always visible.
- **Prompt, follow up, interrupt** — send the initial prompt, push mid-run follow-ups into the live session, or interrupt cleanly.
- **Changeset review & approval** — Claude works in an isolated git worktree; when it finishes, everyone reviews the diff and the owner approves (commit) or rejects (revert).
- **Gap-free late join** — join mid-run and catch up to the exact current state, then go live.
- **Role-scoped access** — reusable invite links map to roles (owner / editor / reviewer / viewer); the server enforces every action.
- **File and diff viewers** — browse the worktree and review per-file diffs; Claude's terminal output replays read-only inside the activity feed (no separate terminal tab).

## How it works

Several cooperating processes run on the host Mac under **Docker Compose** (one container per process); teammates connect over the local network.

```text
                 Host Mac — Docker Compose (bin/start)
┌──────────────────────────────────────────────────┐
│  [rails]    Rails 8 API + ActionCable (Puma :3000)│  ← only published port (→ LAN); serves the SPA
│  [jobs]     Solid Queue   ·   [postgres] Postgres │
│  [sidecar]  Node Fastify :8787 (unpublished)      │  ← wraps @anthropic-ai/claude-agent-sdk
│  [vite]     dev only :5173 (unpublished)          │  ← dev SPA + HMR, fronted by rails
│  Git worktrees: <repo>/.clawdparty/worktrees/…    │  ← one isolated worktree per session
└───────────────────┬──────────────────────────────┘
                    │  same LAN — http://<host>.local:3000
   ┌────────────────┼────────────────┬───────────────┐
 owner's          teammate's       teammate's     …any invited
 browser          browser          browser         developer
```

- **Rails** owns sessions, events, auth, git, and the approval flow, and broadcasts everything over ActionCable.
- **The sidecar** is the only process that talks to the Claude Agent SDK; it uses your existing Claude login (API key, subscription/enterprise, or Bedrock — auth-method-agnostic), normalizes every SDK message into a stable event envelope, and POSTs batches to Rails.
- **The web SPA** subscribes to the event stream and renders the live session.

Everything Claude does lands uncommitted in a per-session git worktree behind human review — your main checkout is never touched.

See [`docs/PLAN.md`](docs/PLAN.md) for the full architecture, data model, event taxonomy, and security model, and [`CLAUDE.md`](CLAUDE.md) for the load-bearing invariants.

## Tech stack

| Layer | Choice |
|---|---|
| Backend | Rails 8 (API + ActionCable), PostgreSQL, Solid Queue + Solid Cable |
| Claude integration | Node + Fastify sidecar wrapping `@anthropic-ai/claude-agent-sdk` |
| Frontend | React 19 + Vite + TypeScript + Tailwind; Zustand + TanStack Query |
| Key web libs | `react-diff-view`, `react-arborist`, `shiki`, `@dnd-kit`, `anser`, `@rails/actioncable` |
| Tooling | Biome (web + sidecar), RuboCop (api), Vitest + RTL, RSpec |

## Getting started

> Prerequisites: macOS host with **Docker** (Docker Desktop or OrbStack). The Ruby 4.0.5, Node 24 LTS, and PostgreSQL 18 toolchain is pinned inside the container images — you don't install them on the host.
>
> **Claude credentials:** the sidecar uses *your existing* Claude login — whatever you already have works, no app-specific key needed. It read-only mounts your `~/.claude` and `~/.aws` and inherits your Claude/AWS auth env, so a direct **API key**, a **Claude subscription / enterprise** login, or **Amazon Bedrock** all work unchanged.
> - **Bedrock:** make sure your AWS session is fresh (`aws sso login`) before `bin/start`.
> - **Subscription / enterprise login on macOS:** that token lives in the macOS **Keychain**, which a Linux container can't read — run `claude setup-token` once and export `CLAUDE_CODE_OAUTH_TOKEN` (the sidecar picks it up).

```bash
git clone <this-repo> && cd clawdparty
bin/setup        # generates SIDECAR_SHARED_SECRET, prepares env
bin/start        # docker compose build + up: Rails (Puma), the sidecar, Solid Queue, Postgres, and Vite
```

Then open the app and create a session pointed at a repo on the host machine.

### Joining from another machine (same LAN)

clawdparty is **LAN-only** for now. Puma binds `0.0.0.0:3000`; teammates on the same network join via the host's mDNS name:

```text
http://<host>.local:3000
```

Open a session, generate an invite link for the role you want to grant, share it, and the invitee picks a display name to join. (Remote access via Tailscale is a planned future phase.)

## Repo layout

```text
clawdparty/
├── docs/PLAN.md          # authoritative design doc — read this first
├── docs/contracts/       # frozen interface contracts (events, sidecar protocol, HTTP API)
├── packages/contracts/   # shared TS types + fixtures/sample_run.jsonl (the executable contract)
├── api/                  # Rails 8 API + ActionCable + PostgreSQL
├── sidecar/              # Node + Fastify + Claude Agent SDK
├── web/                  # React 19 + Vite + TS + Tailwind SPA
├── docker/               # Dockerfiles + entrypoints per service
├── docker-compose.yml    # rails · sidecar · jobs · postgres (+ vite in dev)
├── bin/start             # single entry point: docker compose build + up
└── bin/setup             # one-time machine setup
```

## Development

- **Lint/format:** Biome (`web/`, `sidecar/`) and RuboCop (`api/`).
- **Tests:** RSpec (`api/`), Vitest + React Testing Library (`web/`), Vitest (`sidecar/`).
- **CI:** three independent jobs — `api` (RuboCop + RSpec), `sidecar` (Biome + tsc + Vitest), `web` (Biome + tsc + Vitest).

Larger changes are designed with [OpenSpec](https://github.com/) first — see the `/opsx:*` slash commands and `openspec/`.

## Security model (MVP)

The trusted local network is the perimeter. Every endpoint still requires a valid invite-token-derived signed cookie, roles are enforced server-side, the sidecar container is unpublished (reachable only on the private compose network), and Claude runs pinned to an isolated worktree with everything landing behind human review. The file API defends against path traversal and denylists secrets. See [`docs/PLAN.md` §9](docs/PLAN.md) for the full model and accepted risks.

## Scope

**The core loop** — create/join a session, chat, watch the live activity stream, interrupt, and review + approve/reject diffs — is the product. Out of scope for the MVP: multiplayer/collaborative editing, remote access (Tailscale, future phase), per-tool live approval, and merging session branches to main.
