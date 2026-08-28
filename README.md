# clawdparty

**Real-time collaborative Claude Code sessions in your browser.**

clawdparty turns one AI coding session into a shared room. Any number of developers join from their browser and watch the agent work live on a repo — streamed text and thinking, tool calls, terminal output, per-file diffs, a shared chat sidebar, and — in **review mode** — a human approval gate on every change. One Mac hosts everything, and the browser is a complete participation surface: every capability is reachable from the web UI, and nothing needs a terminal to drive a session.

## Why

Pairing on AI-assisted coding usually means one person screen-sharing while everyone else watches a video feed they can't interact with. clawdparty makes the session itself collaborative: the live agent stream, the diffs, and the chat are all first-class, shared, and gap-free for late joiners — so a whole team can guide one run and review its output together before anything is committed.

## Features

- **Watch the agent live** — streamed text, thinking, tool calls, and terminal output as they happen, in an activity feed built for high event volume that **auto-scrolls** to the newest message (and stays put when you scroll up to read history).
- **Shared chat** — a per-session chat sidebar is the coordination backbone, always visible, with a live roster of who's in the room.
- **Prompt, follow up, interrupt** — send the initial prompt, push mid-run follow-ups into the live session, or interrupt cleanly.
- **Pick the model; the provider follows** — models are discovered live from the login you already have and grouped by provider, because the same model billed through two providers is two different bills. A provider whose credential is missing or expired is listed with the reason and the remedy rather than hidden, and an **Auth test** sends one real request per provider to tell "a credential exists" apart from "a run will work". A live CONTEXT bar tracks usage against the model's real window, and the feed records every context compaction — including the alarming case where no summary came back.
- **Per-run capabilities** — built-in tools are always available; host-configured **MCP connectors** are opt-in per run (measured: 8 servers ≈ 77 tools and ~37,500 tokens of schema, spent every turn before the conversation starts); installed **skills** are indexed by name and description (~4k tokens for 57) and a full instruction body loads only when it applies.
- **Rules that can refuse what the agent does** — bundled extensions gate model-directed commands at `tool:before`, which fails closed. Every participant can read which rules are in force and what each one covers; only the owner toggles them, and a change applies to the next run.
- **Changeset review & approval (review mode)** — the agent works in an isolated git worktree; when it finishes, everyone sees the diff and any **owner, editor, or reviewer** approves (commits on the session branch, attributed to the approver) or rejects (reverts the worktree).
- **Two work streams per session** — one active run per *lane*, so a second stream can run while the first waits on review. The feed stays one interleaved stream with a lane chip, and a diff touching files another lane also changed says so — with the consequence spelled out — before anyone approves.
- **Gap-free late join, crash-safe on both sides** — join mid-run and catch up to the exact current state, then go live. The harness keeps a durable per-session record that is the authority for a run; the Rails event log is a projection of it, and an owner can check that projection and re-derive it.
- **Role-scoped access** — reusable invite links map to roles (owner / editor / reviewer / viewer); the owner can list and **revoke** invites; the server enforces every action.

## How it works

**Four containers plus one host process** run on the host Mac (`bin/start` brings up both halves and reports the health of each); teammates connect over the local network.

```text
                 Host Mac — bin/start
┌─────────────────────────────────────────────────────┐
│  Docker Compose                                     │
│   [rails]    Rails 8 API + ActionCable (Puma :3000) │ ← only published port (→ LAN); serves the SPA
│   [jobs]     Solid Queue   ·   [postgres] Postgres  │
│   [vite]     dev only :5173 (unpublished)           │ ← dev SPA + HMR, fronted by rails
│                                                     │
│  HOST PROCESS (not a container)                     │
│   [harness]  Node + Fastify on 127.0.0.1:8787       │ ← owns the agent loop + the durable record
│                                                     │
│  Git worktrees: <repo>/.clawdparty/worktrees/…      │ ← one isolated worktree per session lane
└───────────────────┬─────────────────────────────────┘
                    │  same LAN — http://<host>.local:3000
   ┌────────────────┼────────────────┬───────────────┐
 owner's          teammate's       teammate's     …any invited
 browser          browser          browser         developer
```

- **Rails** owns sessions, participants, events, invites, git and the approval flow, and broadcasts everything over ActionCable. It owns no capability list: models, connectors, skills, extension rules and AWS profile names are all proxied from the harness at runtime, so a picker can never be a stale hard-coded list.
- **The harness owns the agent loop.** There is no vendor *agent* SDK anywhere: the loop talks the providers' own message APIs, and each provider adapter is the only file permitted to import its own vendor SDK, so adding a provider is a registration rather than a branch. The harness keeps a durable per-session SQLite record that is the authority for a run, and POSTs batched events to Rails.
- **Crash recovery is O(1) in session length.** Every step overwrites one durable position marker; recovery reads that marker and switches on its phase — it never replays the record. Uncertain external effects are bracketed so a crash mid-request cannot double-settle, and no tool call is left without a result.
- **The harness runs on the host, not in a container** (it refuses to boot in one): that is how it reaches any project path with no per-project mount, resolves symlinks that leave a project, sees your toolchain and SSH agent, and reads credential locations a container cannot — notably the macOS Keychain. It binds loopback only, and every route requires a bearer secret, `/healthz` included.
- **The web SPA** subscribes to the event stream and renders the live session.

**In review mode**, everything the agent does lands uncommitted in a per-session git worktree behind human review — your main checkout is never touched. **Chat mode has no worktree and no approval gate:** the agent edits the folder you picked, in place, and you commit or discard those changes yourself. Pick the mode with that in mind; it is fixed for the session's lifetime.

See [`docs/contracts/`](docs/contracts/) for the frozen interfaces (event envelope and taxonomy, the Rails ↔ harness protocol, the client REST + cable API, and the versioned changelog), and [`CLAUDE.md`](CLAUDE.md) for the load-bearing invariants.

## Tech stack

| Layer | Choice |
|---|---|
| Backend | Rails 8 (API + ActionCable), PostgreSQL 18, Solid Queue + Solid Cable |
| Agent harness | Node 24 + Fastify 5 as a host process; provider adapters over `@anthropic-ai/sdk`, `@anthropic-ai/bedrock-sdk`, `@aws-sdk/client-bedrock-runtime`; durable record in SQLite (`better-sqlite3`, WAL) |
| Frontend | React 19 + Vite + TypeScript + Tailwind; Zustand + TanStack Query |
| Key web libs | `react-diff-view`, `react-arborist`, `shiki`, `@dnd-kit`, `anser`, `@rails/actioncable` |
| Tooling | Biome (contracts + harness + web), RuboCop (api), Vitest + RTL, RSpec — all behind one gate, `bin/tests` |

## Getting started

> Prerequisites: a macOS host with **Docker** (Docker Desktop or OrbStack) and **Node 24** available on the host, because the harness runs as a host process (`bin/harness` resolves a pinned 24 via mise/asdf). Ruby 4.0.5 and PostgreSQL 18 are pinned inside the container images — you don't install those.
>
> **Provider credentials:** the harness uses *your existing* login — whatever you already have works, no app-specific key needed. Being a host process, it reads `~/.claude` and `~/.aws` in place (no mounts) and inherits your auth env: a direct **API key**, a **Claude subscription / enterprise** login, or **Amazon Bedrock** all work unchanged.
> - **Bedrock:** make sure your AWS session is fresh (`aws sso login`) before `bin/start`. Nothing can refresh that token on your behalf.
> - **Subscription / enterprise login on macOS:** `claude setup-token` is enough — the harness reads that **Keychain** item directly to build its client, because the provider SDK resolves neither that item nor `~/.claude/.credentials.json` (both belong to Claude Code, not the SDK). Nothing is minted, persisted or transmitted: the token is held only long enough to construct the client, and only the credential's *source* is ever recorded. If macOS refuses the read — the item was created by another application, so its ACL may prompt or refuse — export `CLAUDE_CODE_OAUTH_TOKEN` instead and no Keychain is involved. The failure message says which case you are in.

```bash
git clone <this-repo> && cd clawdparty
bin/setup        # generates HARNESS_SHARED_SECRET, installs harness deps, creates the store dir
bin/start        # the harness as a HOST process, then the containers; reports the health of each
```

**Point it at your repos.** `TARGET_REPO_PATH` is the **absolute** host directory the agent is allowed to work in — set it to the **parent folder of your repos** so the in-app folder picker can browse them all. Rails and the job runner **must** bind-mount it at the *identical* container path, and do: Rails is what creates each session worktree (`git worktree add`) and runs the diff/approve/reject git operations, all from inside a container — and a worktree's gitdir metadata holds **absolute** paths. The host harness, which edits inside that checkout, only resolves them when the container path and the host path are the same string. It is also what keeps a worktree openable on the host, in your editor or GitHub Desktop. Set it in `.env.local` before `bin/start`:

```bash
TARGET_REPO_PATH=/Users/you/dev     # absolute; the parent of the repos you want to work on
```

Then open `http://localhost:3000` (or `http://<host>.local:3000` from another machine) and create a session — see **[Using a session](#using-a-session)** below.

### Joining from another machine (same LAN)

clawdparty is **LAN-only** for now. Puma binds `0.0.0.0:3000`; teammates on the same network join via the host's mDNS name:

```text
http://<host>.local:3000
```

Open a session, generate an invite link for the role you want to grant, share it, and the invitee picks a display name to join. (Remote access via Tailscale is a planned future phase.)

### Keeping the harness running (optional)

The harness is a host process, so nothing supervises it by default — `bin/start` launches it and
`bin/harness status` tells you whether it is up. A crash means the next run fails until you run
`bin/harness start` again, and it does not come back after a reboot.

Units for both platforms ship in `docker/launchd/` and `docker/systemd/` if you want that handled.
**Installing them is deliberately opt-in, not part of `bin/setup`:** a login agent starts a process
that reaches your repos and your credentials every time you log in, and that should be a decision
you make rather than a side effect of cloning a repo.

```bash
# macOS — a USER agent, never a system daemon: the harness must run as you, with your
# Keychain, SSH agent and toolchain. A root daemon would have none of them.
sed -e "s|REPO_ROOT_PLACEHOLDER|$PWD|g" -e "s|HOME_PLACEHOLDER|$HOME|g" \
  docker/launchd/com.clawdparty.harness.plist \
  > ~/Library/LaunchAgents/com.clawdparty.harness.plist
launchctl load -w ~/Library/LaunchAgents/com.clawdparty.harness.plist

# undo
launchctl unload -w ~/Library/LaunchAgents/com.clawdparty.harness.plist
rm ~/Library/LaunchAgents/com.clawdparty.harness.plist
```

Worth knowing if you skip it: the unit sets an explicit `PATH` with version-manager shims **ahead of
the package manager**, so a supervised run resolves the same tool versions you get in your own shell.
An interactively started harness inherits whatever `PATH` your shell had, which for a
non-interactive invocation can differ — a mise-pinned project once resolved Node 26 under a
mis-ordered `PATH` where the developer got Node 22.

## Using a session

1. **Create a session.** On the landing page, enter a title + your display name, choose a **mode**, and pick the **working directory** with the folder browser (it lists the git-repo folders under `TARGET_REPO_PATH`):
   - **Review mode** — the agent works in an isolated **git worktree** of the repo you pick; its changes are held for review and approve/reject. Pick a folder that *is* a git repo.
   - **Chat mode** — the agent runs directly in the chosen folder — no worktree, no diff/approval. Good for exploring, or working in a non-git directory; the review panel says exactly that instead of showing an empty space.
   - Mode is fixed for the session's lifetime.
2. **Invite your team.** As owner, mint a **role-scoped invite link** (owner / editor / reviewer / viewer) and share it. The invitee opens it, picks a display name, and joins the same live session. Roles are enforced server-side — the UI just hides what a role can't do.
3. **Drive the agent.** Optionally pick the **model** and switch on any **MCP connectors** you want for this run, type a prompt, and **Run**. The activity feed streams text, thinking, tool calls, and terminal output live and auto-scrolls to the newest. Send **mid-run follow-ups**, or **Interrupt** to stop cleanly. Chat is always available in the sidebar for coordination.
4. **Review & decide (review mode).** When a run finishes with changes, the **diff appears for everyone**. Any **owner, editor, or reviewer** then:
   - **Approve** → commits the changeset onto the session branch (`clawd/session-<id>`), attributed to the approving participant, and leaves a clean tree for the next run,
   - **Reject** → reverts the worktree (`git reset --hard && git clean -fd`) and severs the resumed context, because a context that believes reverted edits still exist is worse than no context at all, or
   - **Revise** (owner/editor) → send a follow-up that keeps the changes and continues, reviewing the cumulative diff as one changeset.
5. **Iterate.** Each run's diff is incremental from the last approval. In review mode your **main checkout is never touched** — everything lands in the per-session worktree under `<repo>/.clawdparty/worktrees/`.

**Settings** is its own page per session, readable by every role and writable by the owner: the session's configuration and archive control, its default provider / model / AWS profile, the auth test, host skill management, and the extension rules that can refuse a tool call.

### Roles

| Role | Can do |
|---|---|
| **owner** | Everything: run / interrupt, **approve / reject**, change the working directory, mint & revoke invites, manage settings, archive |
| **editor** | Run the agent, follow-ups, interrupt, revise, **approve / reject**, chat |
| **reviewer** | Review + **approve / reject**, chat — no running the agent |
| **viewer** | Watch + chat only |

Approve/reject is available to everyone except **viewer**; driving the agent (run / follow-up / interrupt / revise) is owner + editor; invites, settings and archive are owner-only. The server (`SessionPolicy`) enforces this on every request — the UI only hides what a role can't do, and a non-participant gets a 404 before a wrong role gets a 403.

## Repo layout

```text
clawdparty/
├── docs/contracts/       # frozen interface contracts (events, harness protocol, HTTP API) + CHANGELOG
├── packages/contracts/   # shared TS types + fixtures/sample_run.jsonl (the executable contract)
├── api/                  # Rails 8 API + ActionCable + PostgreSQL
├── harness/              # Node + Fastify: the agent loop, provider adapters, the durable record
├── web/                  # React 19 + Vite + TS + Tailwind SPA
├── docker/               # Dockerfiles + entrypoints per service; launchd/systemd units for the harness
├── docker-compose.yml    # rails · jobs · postgres (+ vite in dev) — the harness is NOT a service
├── bin/start             # both halves: the host harness and the containers
├── bin/harness           # the host process alone: start|stop|restart|status|logs|sessions|reset-session
├── bin/tests             # the whole CI gate: contracts · harness · web · api · guards
└── bin/setup             # one-time machine setup
```

## Development

- **Lint/format:** Biome (`packages/contracts/`, `harness/`, `web/`) and RuboCop (`api/`).
- **Tests:** RSpec (`api/`), Vitest + React Testing Library (`web/`), Vitest (`harness/`, `packages/contracts/`).
- **One gate:** `bin/tests` runs every group in order — `contracts`, `harness`, `web`, `api`, `guards` — and the five CI workflows each call it, so a green run locally means a green CI. `bin/tests --list` prints the groups; `bin/tests <group>` runs one.
- **Guards:** `bin/check-docs` fails when this README or `CLAUDE.md` names a file, path or constant that does not exist; `bin/check-room` guards the one-ordered-stream invariant. Documentation drift is a test failure here, not a matter of taste.
- **Live verification:** the `bin/verify-*` scripts drive the running stack end to end — the core loop, crash recovery, a Rails restart, projection repair, lanes, the context window, and a five-participant shared room.

## Troubleshooting

- **`Worktree is dirty; cannot start a fresh run`** — a review changeset from a prior run is still pending. Approve, reject, or revise it first (a fresh run needs a clean tree).
- **`Could not prepare the session worktree — is the target repo a git repository?`** — the folder you picked for a **review** session isn't a git repo. Pick a git repo, or use **chat mode**.
- **A run fails with a harness 500 and the store reports `incompatible_version`** — that session's record predates a store-schema bump, and a record is refused rather than migrated (misreading an older layout is how a record silently lies). `bin/harness sessions` lists every store and flags the refusable ones; `bin/harness reset-session <id>` moves the store aside so the session starts a fresh one. The Postgres projection keeps the feed's history; the session just can't resume its model conversation.
- **Empty "Thinking" block on Amazon Bedrock** — Bedrock returns *encrypted* (signature-only) extended thinking, so there's no text to render (the answer text still streams normally). A direct **API key** or **subscription/OAuth** login surfaces readable thinking.
- **A harness code change didn't take effect** — the harness runs from source without watch mode; reload it with `bin/harness restart` (only affects new runs).
- **Not logged in / auth errors** — run the **Auth test** in session settings to see which provider is failing and why, then refresh the host login it names: `aws sso login` for Bedrock, or `claude setup-token` (plus an exported `CLAUDE_CODE_OAUTH_TOKEN` if the Keychain read is refused) for a subscription/enterprise login.

## Security model

The trusted local network is the perimeter. Every endpoint requires a valid invite-token-derived signed cookie, and roles are enforced server-side. **In review mode** the agent is pinned to an isolated worktree with everything landing behind human review; **in chat mode there is no worktree and no review gate**, so a chat session is a decision to let the agent edit the directory you named — treat the mode choice as part of this model, not a convenience. The harness binds host loopback and authenticates **every** route with a bearer secret under a constant-time compare, `/healthz` included — placement is not the boundary, because loopback is reachable by every other process running as you. It also runs with your own privileges, which is why the tool-gating extension point is the primary containment mechanism and fails closed. No credential is ever owned by the app: discovery records which source won, never the value. The file API defends against path traversal and denylists secrets. See [`docs/contracts/harness_protocol.md`](docs/contracts/harness_protocol.md) and [`CLAUDE.md`](CLAUDE.md) for the enforced invariants.

## Scope

**The core loop** — create/join a session, chat, watch the live activity stream, interrupt, and review + approve/reject diffs — is the product, and is never cut. Deliberately not built: multiplayer/collaborative editing (CRDT, Monaco), remote access (Tailscale — a future phase), interactive per-tool approval prompts (bundled rules refuse automatically instead), third-party extension loading (a worker thread cannot contain code that reads your credentials, so loading it would be a trust decision dressed up as a boundary), and merging session branches to main.
