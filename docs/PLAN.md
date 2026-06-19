# clawdparty — Real-Time Collaborative Claude Code Session Server

**3-week plan · Team: Shah Rukh, Snehal (W1-3), Manish (W1 unavailable) · Host: Shah Rukh's Mac, same local network (LAN) — Tailscale/remote hosting is a future phase**

*Plan finalized: 2026-06-12 · Updated: 2026-06-19 (timeline compressed to 3 weeks; Manish unavailable W1) · local dev runs on **Docker Compose** — one container per process, `bin/start` as the single entry point.*

> **As-of note:** this plan is written in the original pre-build future tense (e.g. "W1 spike before freeze"). The week-by-week schedule (§10) and milestone narration are the historical plan of record; treat the **specs in `openspec/changes/`** as the current authority for what is built, and the dated execution timeline as the original sequencing intent rather than a live status board.

## 1. Context & goal

We're building a real-time collaborative coding session server: **any number of developers** join a browser session and watch/guide Claude Code working live on a repository on Shah Rukh's Mac. Shared chat (per-session sidebar), live Claude activity stream, file/diff viewers, and a human approval flow for Claude's changes. (The task board and a dedicated terminal tab are modeled in the schema/events but cut from the MVP UI per §12 — terminal output and tool events render in the activity feed.) Timeline: **3 weeks** (Manish joins Week 2 — Week 1 is Shah Rukh + Snehal only), built by 3 people total — but sessions are not limited to 3 participants.

**Key usage model:** Shah Rukh's Mac is only the *host machine* (Rails + sidecar + repo live there). **Shah Rukh participates exactly like everyone else — through the browser**: he joins the session, prompts Claude, chats, and reviews diffs from the web UI (with the `owner` role, so he's also the one who approves/rejects). Nobody drives Claude from a terminal; the web session IS the interface.

**Key decisions:**
- Frontend: **React 19 + Vite + TypeScript SPA**
- Claude integration: **Node.js sidecar wrapping `@anthropic-ai/claude-agent-sdk`** (streaming events, streaming input for mid-run follow-ups, clean `interrupt()`)
- Approval UX: **changeset review** — Claude finishes → everyone reviews the git diff → host approves (commit) or rejects (revert). NOT per-tool-call gating (the `canUseTool` seam is designed in but not built).
- Networking: **same-LAN only for MVP** — teammates connect to Shah Rukh's Mac directly over the local network (`http://<shah-mac>.local:3000`). Tailscale / remote hosting is a future phase.

**Out of MVP scope:** multiplayer editing, CRDT/Yjs, cursors, Monaco, **remote access (Tailscale / Cloudflare Tunnel / cloud hosting — future phase)**, per-tool live approval, merging session branches to main (manual host git op).

## 2. Architecture decisions (final)

| Decision | Choice | Why (one line) |
|---|---|---|
| Database | **PostgreSQL** | Anticipating future cloud deployment; Solid Queue/Cable both support it; local dev via Postgres.app or Docker |
| Jobs / Cable | **Solid Queue + Solid Cable** | No Redis to babysit; long-running work lives in the sidecar process, not jobs |
| Local dev runtime | **Docker Compose — one container per process**, `bin/start` builds + `docker compose up`; source bind-mounted (`:delegated`), deps in named volumes | Single entry command; reproducible toolchain (Ruby/Node/PG pinned in images); decoupled-lifecycle invariants map cleanly onto per-service containers |
| Sidecar topology | **One long-lived HTTP service as its own container** (`sidecar` service, restart policy, NOT a child of Rails); reachable from Rails at `http://sidecar:8787` over the compose network; port **not published** to the host/LAN | Decoupled lifecycles: Rails restarts don't kill Claude runs; curl-debuggable from inside the compose network |
| Rails↔sidecar auth | Shared bearer secret (`SIDECAR_SHARED_SECRET` from `bin/setup`) + sidecar reachable only on the private compose network (no published port) | Adequate for same-host IPC; container isolation replaces loopback binding |
| Claude auth (sidecar → Anthropic) | **Auth-method-agnostic passthrough of the host's existing Claude login.** The sidecar container read-only bind-mounts `~/.claude` + `~/.aws` and inherits the host's Claude/AWS auth env (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`/`CLAUDE_CODE_USE_VERTEX`, `AWS_PROFILE`/`AWS_REGION`, `ANTHROPIC_MODEL`). No code picks a method — direct API key, Claude subscription/enterprise OAuth, and Amazon Bedrock all "just work". | Developers run whatever login they already have; the SDK auto-detects in its own precedence order. **Two caveats:** (1) macOS subscription/enterprise OAuth lives in the **Keychain, not a file** — invisible to a Linux container — so for that mode the dev runs `claude setup-token` once and we pass `CLAUDE_CODE_OAUTH_TOKEN`; (2) Bedrock-over-AWS-SSO tokens expire — the host must stay `aws sso login`-fresh (the live mount reflects it; the container can't refresh on its own). |
| Git isolation | **One worktree per session** (`.clawdparty/worktrees/session-<id>`, branch `clawd/session-<id>`) | Shah Rukh's main checkout stays untouched; reject is scoped to worktree |
| Auth | **Role-scoped, reusable invite links** (SHA-256 token digests, optional expiry/revoke) → display name → **signed httpOnly cookie**; no passwords | N developers join from one shared link per role; the trusted LAN is the perimeter and tokens gate everything; cookie also authenticates ActionCable |
| Frontend state | **Zustand** (event streams) + **TanStack Query** (fetched resources) | Selector granularity survives delta floods; Redux is boilerplate at this scope |
| Key libs | `react-diff-view`, `react-arborist` (tree), `shiki` (highlight), `@dnd-kit` (board), `anser` (ANSI) | Output-only terminal pane: no xterm.js needed |
| Network (MVP) | Only the `rails` service **publishes a port** (`3000:3000`, reachable on the LAN); join URLs use `http://<shah-mac>.local:3000` (Bonjour/mDNS, survives DHCP changes); sidecar + Vite are **unpublished** (compose-network only) | Same trusted office/home network; invite tokens + signed cookies gate every request; not publishing a service's port is the Docker equivalent of loopback-only; Tailscale is a drop-in future phase (publish/forward + origins, no app changes) |
| Lint/format | **Biome** for web + sidecar (single tool, no ESLint/Prettier split); **RuboCop** with a standard baseline (line length 120, frozen string literals, required parens) via rubocop-rails/rubocop-rspec | One linter per stack; near-zero config debate |

## 3. System topology

```text
            Shah Rukh's Mac — Docker Compose (bin/start)
┌──────────────────────────────────────────────────────┐
│  [container: rails]  Rails 8 API + ActionCable        │
│    Puma :3000  ── the ONLY published port (→ LAN)     │
│    serves built SPA                                    │
│  [container: jobs]   Solid Queue supervisor (bin/jobs)│
│  [container: sidecar] Node Fastify :8787 (unpublished)│
│    └── @anthropic-ai/claude-agent-sdk query()         │
│    reachable from rails as http://sidecar:8787         │
│    binds host ~/.claude + ~/.aws (ro); target repo (rw)│
│    inherits host Claude/AWS auth env (any login mode)  │
│  [container: postgres] PostgreSQL 18 (named volume)    │
│  [dev only, container: vite] Vite :5173 (unpublished)  │
│  Git worktrees (bind-mounted): <repo>/.clawdparty/…    │
└───────────────────┬────────────────────────────────────┘
                    │ Same LAN (HTTP/WS via http://<shah-mac>.local:3000)
                    │ — only the rails port is published · [future phase: Tailscale]
   Dev request flow: the browser hits rails:3000 only. Rails serves /api + /~cable
   itself and reverse-proxies all other requests (SPA + Vite HMR ws) to the unpublished
   vite container. In prod, rails serves the built SPA. (Vite still proxies /api+/~cable
   back to rails for the direct-on-compose-network case.)
   ┌────────────────┬───┴──────────┬──────────────┐
Shah Rukh's      Snehal's      Manish's      …any invited
browser (owner)  browser       browser       developer
```

All humans — including Shah Rukh — interact through the browser session. The session UI is the only interface to Claude; participants per session are unbounded (invite links are reusable).

## 4. Repo layout (monorepo)

```text
clawdparty/
├── docs/contracts/        # frozen interface contracts (events.md, sidecar_protocol.md, http_api.md, CHANGELOG.md)
├── packages/contracts/    # shared TS types + fixtures/sample_run.jsonl (the executable contract)
├── api/                   # Rails 8 API + ActionCable + PostgreSQL
├── sidecar/               # Node + Agent SDK
├── web/                   # React 19 + Vite + TS + Tailwind
├── docker/                # Dockerfiles + entrypoints per service (rails, sidecar, web)
├── docker-compose.yml     # rails · sidecar · jobs · postgres (+ vite in dev); named volumes
├── .dockerignore
├── bin/start              # single entry point: docker compose build + up
└── bin/setup              # generates SIDECAR_SHARED_SECRET + prepares env (DB creation runs in the rails container entrypoint, gated on postgres health)
```

## 5. Data model (api/)

**Mutable:** `users` (name), `sessions` (title, objective, status, repository_path, worktree_path, branch_name, base_branch, host_id), `invites` (token_digest, role, expires_at), `participants` (session, user, role enum: owner/editor/reviewer/viewer, last_seen_at), `tasks` (title, status enum: todo/doing/review/done/blocked, owner, position), `ai_runs` (state machine: queued/running/awaiting_review/approved/rejected/superseded/completed_clean/failed/interrupted; prompt, claude_session_id, model, base_sha, total_cost_usd, usage, diff_stats, requested_by, reviewed_by).

**Append-only:** `messages` (chat: kind user/claude/system), `events` (event_type, actor_kind, ai_run_id, seq, payload JSON).

**Two load-bearing constraints:**
- `add_index :ai_runs, :session_id, unique: true, where: "status IN ('queued', 'running', 'awaiting_review')"` — **one active run per session, enforced at the DB**. (`status` is a native PG enum / string column, so the predicate compares string literals — never integer-backed.)
- `add_index :events, [:ai_run_id, :seq], unique: true` — sidecar assigns per-run monotonic `seq`; ingestion silently skips dupes → retries/replays are safe. Global `events.id` is the client cursor.

Every mutation to mutable tables appends a corresponding event in the same transaction (`Events::Append`), so the event stream alone reconstructs the UI.

## 6. Event pipeline

```text
SDK message → sidecar/src/normalizer.ts → batched POST /internal/events
  → Events::Ingest (persist unless ephemeral; dedupe by [run_id, seq])
  → SessionChannel.broadcast_to(session)  → web/src/lib/cable.ts → Zustand stores
```

**Workspace layout (per session):** left sidebar = participants + presence; center tabs = Activity | Files | Diff (terminal output and tool events render inside Activity; the dedicated Terminal and Tasks tabs are cut per §12); **right sidebar = the session's chat** (always visible, not buried in a tab — chat is the coordination backbone). Messages and all events are scoped to the session.

**Taxonomy (20 types + the `ai_raw` fallback):** `run_started`, `ai_text_delta` (ephemeral — broadcast, never persisted; coalesced ~150ms in sidecar), `ai_text` (durable, on block stop), `ai_thinking`, `tool_started/tool_finished/tool_failed` (summarized inputs — path/command/500 chars, never full Edit payloads), `terminal_output` (from Bash Pre/PostToolUse hooks, 64KB chunks), `file_changed`, `run_finished/run_failed/run_interrupted`, `changeset_ready/changeset_approved/changeset_rejected`, `chat_message`, `task_created/task_updated`, `participant_joined`, `presence_changed` (ephemeral). Any SDK message the normalizer can't map becomes `ai_raw` (never dropped, never a crash).

**Late-joiner catch-up (gap-free):** subscribe to cable FIRST → buffer live events → REST backfill `GET /api/sessions/:id/events?after=<cursor>` → drain buffer applying only `id > maxBackfilledId` → live. Stores dedupe **durable** events by `event.id`; **ephemeral events (`ai_text_delta`, `presence_changed`) have a null `id`, bypass backfill entirely, and are not deduped by id** (deltas accumulate by `(ai_run_id, block)`, presence is last-writer-wins). Lives in one file: `web/src/lib/cable.ts`.

## 7. Rails ↔ sidecar protocol

- **Rails → sidecar (`http://sidecar:8787` over the compose network):** `POST /runs` {run_id, session_id, repo_path(worktree), prompt, requested_by (participant id → stamped as `run_started.actor.id`), claude_session_id?, model, max_turns, permission_mode: acceptEdits, allowed_tools} (409 if run active); `POST /runs/:id/messages` (pushed into the live streaming-input iterable — no respawn); `POST /runs/:id/interrupt`; `GET /healthz` → {active_run_ids}. The sidecar host is configurable (`SIDECAR_URL`) so the app never hard-codes a transport assumption.
- **Sidecar → Rails:** `POST /internal/events` (batched, idempotent); `POST /internal/sidecar/heartbeat` every 5s with active_run_ids.
- **Crash recovery:** sidecar dies → its container's restart policy reboots it; `Sidecar::HealthcheckJob` marks runs stale >15s as failed; Claude session JSONL persists in the bind-mounted host `~/.claude/projects/` (survives container restarts) so the host can resume via `claude_session_id`; partial worktree edits get reviewed/rejected like any changeset. Rails restarts → sidecar ring-buffers events + retries with backoff (idempotent ingest); boot reconciliation marks orphans failed.

**Sidecar files:** `index.ts` (Fastify + heartbeat), `runner.ts` (RunManager: query handle, pushable input iterable, lifecycle), `normalizer.ts` (**the ONLY file that sees raw SDK shapes**; unknown types → `ai_raw`, never a crash), `transport.ts` (batch/retry), `hooks.ts` (Bash→terminal_output, Edit/Write→file_changed), `permissions.ts` (canUseTool allow-all for MVP — **the seam** for later Bash gating).

## 8. Git isolation & approval flow

1. Session create: `Git::WorktreeManager` → `git worktree add … -b clawd/session-<id> <base_branch>`.
2. Run start (`Runs::Start`): requires no active run (DB index) + clean worktree (except revise); records `base_sha`.
3. Run end (`Runs::Finalize`): `git add --intent-to-add -A && git diff HEAD --numstat` (untracked files covered) → dirty → `awaiting_review` + `changeset_ready`; clean → `completed_clean`. Interrupted + dirty → also `awaiting_review`.
4. Diff over **REST, never cable**: `GET /api/runs/:id/diff` (`Git::DiffBuilder`).
5. **Approve** (owner only): commit on session branch, author `Claude (clawdparty)`, trailers `Approved-by` + `Clawdparty-Run`.
6. **Reject** (owner only): `git reset --hard HEAD && git clean -fd` scoped to worktree. **Hard rule: reject severs `claude_session_id` chaining** (Claude's context believes reverted edits exist).
7. **Revise**: old run → `superseded`; new run resumes same Claude session, dirty tree kept; cumulative diff reviewed as one changeset.
8. Mid-run follow-ups: editors post messages into the live run (streaming input).

## 9. Security

- **Perimeter (MVP):** the trusted local network. Only the `rails` container publishes a port (`3000`); `config.hosts` allows `<shah-mac>.local` + LAN IP; sidecar/Vite are unpublished (compose-network only — the Docker equivalent of loopback-only); signed cookies without `Secure` flag (plain HTTP on LAN). Accepted risk: anyone on the same network can reach the login page — but every endpoint requires a valid invite-token-derived cookie, and only colleagues are on the network. Future phase: Tailscale (publish/forward the rails service + add origins; no app-level changes — this is why nothing in the app assumes a fixed host).
- **Roles** enforced server-side in `api/app/policies/session_policy.rb` (PORO, every controller action) — owner: everything incl. approve/reject; editor: runs/follow-ups/interrupt/tasks/chat; reviewer: tasks/chat/view; viewer: view/chat. Cable subscriptions independently verify participantship. Client hides buttons; server enforces. (The `tasks/*` permissions are **dormant while the task board UI is cut** per §12 — the role grants and the `tasks` table + `task_*` events are modeled now so restoring the board needs no schema or policy change.)
- **File API** (`RepoBrowser`): tree from `git ls-files --cached --others --exclude-standard`; content with realpath-containment (defeats `../` and symlinks), denylist (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `*secret*`, `.git/`…), 1MB cap, null-byte binary detection. **Terminal pane is read-only replay of Claude's Bash events — no input path to a shell anywhere.**
- Claude blast radius: allowedTools whitelist, cwd pinned to worktree, everything lands uncommitted behind human review. (SDK doesn't hard-jail Bash to cwd — accepted MVP risk, documented.)
- **Claude credentials:** the sidecar never stores its own Anthropic key. It uses the host developer's existing login, mounted read-only (`~/.claude`, `~/.aws`) plus inherited auth env. Accepted MVP risk: those credentials are the host's, so a run bills/acts as the host — fine for same-host, single-developer-credential MVP. The mounts are **read-only** so a run cannot tamper with the host's login state.

## 10. 3-week execution plan

**Phase structure:** the 3 weeks are bookended by review phases —
- **Days 1–2 (W1 Mon–Tue): Architecture review phase.** No feature building. Shah Rukh + Snehal review this plan and challenge every decision (Manish out W1); Shah Rukh runs the SDK spike (validating the riskiest assumption is part of review); contracts drafted against real spike output.
- **Days 3–13: Building phase.** Starts Wed W1 with the contract freeze; ends Wed W3.
- **Last 2 days (W3 Thu–Fri): Complete project review phase.** Cross-stream code review, security review, docs walkthrough, final end-to-end verification. No new features.

Ownership (swappable; contracts make handoffs cheap): **Shah Rukh = sidecar + integration** (sidecar is inseparable from his machine/credentials; integrator and riskiest stream co-located), **Snehal = Rails backend** (deepest pure-Rails stream), **Manish = frontend (W2-3 only; unavailable W1)**. W1 frontend scaffolding (Vite/React/routes only, no features) covered by Shah Rukh to unblock Manish on day 1 of W2. Streams integrate continuously — never batched to week-end; each week has a concrete working milestone (below) as its acceptance gate.

### Week 1 — Review phase (Mon–Tue), then contracts + skeletons (Shah Rukh + Snehal only; Manish unavailable)
**Milestone: Rails + sidecar can replay the fixture end-to-end; frontend scaffold exists (routes/shell only, zero features) for Manish to build on top of in W2.**

**Mon–Tue — Architecture review (Shah Rukh + Snehal only):**
- Mon: Shah Rukh + Snehal walk through this plan section by section — challenge stack choices, data model, event taxonomy draft, protocol, git/approval flow, security model; agree repo layout; assign streams; draft the three contracts. Manish will review async and raise any concerns by Wed AM.
- Tue: **Shah Rukh** runs the Agent SDK spike on a toy repo — capture every raw message type, exercise streaming input/interrupt/resume, save raw logs as fixtures (this validates the architecture's riskiest assumption). **Snehal** reviews/refines the REST+cable API shapes, role matrix, and migration plan against the draft contracts; preps CI config.
- Tue EOD: spike findings written up and shared with Manish. **Wed: contract freeze** (only after the spike — schemas invented before seeing real SDK output are fiction; Manish sign-off by Wed noon).

**Wed–Fri — Build starts (Shah Rukh + Snehal; Shah Rukh covers minimal frontend scaffold):**
- **Shah Rukh (3.5d):** **Docker Compose scaffold + `bin/start`** (rails · sidecar · jobs · postgres · vite services, bind-mounted source, named volumes for gems/node_modules, sidecar binds host `~/.claude` + the target repo) so every stream develops in containers from day one (0.5d); sidecar skeleton: HTTP server, normalizer v1, event POST to Rails (1.5d); `packages/contracts` TS types + `fixtures/sample_run.jsonl` from real spike output (0.5d); **minimal frontend scaffold: Vite + React + Biome + routes + app shell component (zero features), CI green** (1d). Goal: Manish can `bin/start` on Mon W2 and immediately start building features against a working skeleton. (Integration buffer absorbed into the Docker setup; watch this as a pace risk.)
- **Snehal (3.5d):** Rails scaffold + PostgreSQL + RuboCop + CI (0.5d); models/migrations incl. events + constraints (1d); invite-link auth + cookie (0.5d); `SessionChannel` + `POST /internal/events` ingest→persist→broadcast (1d); **fake-Claude rake task** replaying `sample_run.jsonl` through real ingest (0.5d).

### Week 2 — Live Claude end-to-end (all three; Manish joins Mon)
**Milestone: Claude runs live and is watchable from multiple browsers; owner can prompt and interrupt; a mid-run joiner catches up correctly; verified cross-machine over the LAN from Snehal's/Manish's own laptops.**
- **Shah Rukh (4d):** run lifecycle/state machine in sidecar (1d); worktree creation + base_sha recording (1d); normalizer full coverage: deltas/tools/terminal/result (1d); interrupt + streaming follow-ups + heartbeat (1d).
- **Snehal (4d):** run orchestration `POST /sessions/:id/runs` → sidecar, status from events, role checks (1d); event store hardening: pagination, payload caps (0.5d); **file tree + content API with traversal request specs** (1.5d); **diff API** with intent-to-add (1d).
- **Manish (4d, starts Mon W2):** inherit the W1 frontend scaffold; **cable.ts wrapper + event reducer with backfill/buffer/drain** (1.5d); activity feed real rendering: streamed text, collapsible tool chips, run banners (1.5d); prompt composer + follow-up + interrupt button, role-gated, chat panel + presence stub (1d).

### Week 3 — Full loop + hardening + final review (build freezes Wed EOD)
**Milestone: full loop works — prompt → watch live → review diff → approve commits / reject reverts, roles enforced; clawdparty used on itself over the LAN; final verification run by Snehal or Manish from their own laptop using only the README.**

**Mon–Wed — final build (all three, ~3d each):**
- **Shah Rukh:** sidecar supervision: container restart policy, SIGTERM/graceful shutdown, restart recovery via resume (1d); LAN serving config: Puma `0.0.0.0` binding inside the `rails` container + only that port published, `config.hosts`, cable allowed origins for `.local`/LAN-IP, mDNS join-URL docs (0.5d); pair with Snehal on changeset service over real worktrees (0.5d); security hardening: token expiry/revocation, secret review, confirm sidecar/Vite ports stay unpublished (0.5d); runbook + README incl. LAN join instructions (0.5d).
- **Snehal:** **changeset service: approve=commit / reject=revert + unit tests** (untracked, gitignored, empty diff, dirty-at-start, reject-leaves-clean) (1.5d); role-enforcement pass + request-spec matrix (1d); test backstop: auth/role/traversal specs, git edge specs, **one happy-path system test via fixture replay** (0.5d).
- **Manish:** **diff viewer** (react-diff-view, per-file list, stats) (1.5d); **approval UI** (review screen, approve/reject/revise, owner-gated) (1d); mid-run join/reconnect resync + UI polish: loading/empty/error states (0.5d).

**Thu–Fri — Complete project review (all three; no new features, fixes only):**
- Thu AM: **cross-stream code review** — each person reviews a stream they didn't build (Shah Rukh→Rails backend, Snehal→frontend, Manish→sidecar); findings triaged into fix-now vs backlog.
- Thu PM: **security review checklist** — path traversal + denylist on file API, role-enforcement matrix endpoint by endpoint, invite token lifecycle, cable subscription auth, sidecar unpublished-port/secret, git reject leaves clean worktree.
- Fri AM: fix-now items; README/runbook walkthrough executed cold by a non-author; dogfood: use clawdparty on itself, capture any final issues.
- Fri PM: **final end-to-end verification run by Snehal or Manish from their own laptop, using only the README** (proves owner-independence + docs); future-phase backlog written up (Tailscale, per-tool Bash gating, Monaco, cloud).

## 11. Contracts — freeze Wednesday of Week 1 (only after the spike findings are in, never before)

1. **Event taxonomy + envelope** (`docs/contracts/events.md` + `packages/contracts/src/events.ts`) — `{id, session_id, ai_run_id, seq, type, actor, ts, payload}`.
2. **Rails↔sidecar protocol** (`docs/contracts/sidecar_protocol.md`) — incl. the worktree convention (who creates it, path layout, base_sha rule). This is the A↔B seam.
3. **REST + cable API** (`docs/contracts/http_api.md`) — endpoints, role matrix, rule: *everything live arrives as a Contract-1 event*, no bespoke cable messages.

`fixtures/sample_run.jsonl` (from real spike output) is the **executable contract**: Manish renders it, Snehal's seed replays it, Shah Rukh's normalizer tests assert producing it. Post-freeze changes require sign-off from all three + a CHANGELOG entry; additive types cheap, envelope changes are emergencies.

**Stub strategy (nobody waits for anybody):** frontend builds against fixtures; Rails is exercised end-to-end via the fake-Claude replay; sidecar logs to stdout before ingest exists; diff viewer builds against a checked-in sample diff JSON.

## 12. Scope-cut ladder (execute mechanically if a weekly milestone slips >1 day)

**Already cut in the 3-week timeline:** task board, terminal tab (both terminal output + tool events already visible in the activity feed — these would be nice-to-have polish).

**If still behind, cut top-down:** 1) file tree/viewer (diff viewer covers review; skip browsing unrelated files) → 2) presence indicators (participant list without online/offline status is enough) → 3) mid-run follow-ups (queue follow-ups until run end instead of streaming input) → 4) collapse roles to owner-vs-everyone (skip editor/reviewer/viewer distinction) → 5) sidecar-restart session resume (restart = new run is acceptable for MVP).

**Never cut:** session create/join, chat, live activity stream, interrupt, diff review + approve/reject. These five pieces ARE the product. If ahead (unlikely at 3 weeks): re-add task board or terminal tab, surplus goes to hardening, never new features.

## 13. Testing strategy

Tests where bugs are catastrophic/invisible: request specs for join auth + role matrix + **path traversal** + ingest secret; normalizer unit tests (raw fixtures in → contract events out — doubles as contract verification); changeset git edge-case units; one happy-path system test (fixture replay → events → changeset → approve → commit exists). Skipped deliberately: exhaustive frontend tests (strict TS + shared types carry the weight; 2-3 vitest cases for the reducer), cable units, browser E2E, load tests. CI: GitHub Actions, three dumb jobs (api: rubocop+rspec / sidecar: biome+tsc+vitest / web: biome+tsc+vitest). Frontend tests follow the team's established conventions: **Vitest + React Testing Library, `.test.tsx` co-located with components, MSW** (`setupServer`) for REST mocking.

## 14. Top risks

| Risk | Mitigation | Early warning |
|---|---|---|
| SDK event-shape surprises (least-known dep; schema derives from it) | W1 spike before freeze; fixtures checked in; normalizer = only SDK-aware file; pin SDK version | Spike can't map messages to draft taxonomy by Wed W1 → delay freeze 2 days |
| Run-lifecycle bugs (orphans, double-active, stuck review) | State machine in one place; **DB partial unique index**; heartbeat + boot reconciliation built W2 | Runs stuck "running" after sidecar restart |
| Streaming UX jank (delta floods) | Ephemeral vs durable two-tier; 150ms coalescing; Zustand selectors; capped feed | Feed jank during W2 live runs; >10-20k events per modest run |
| Git edge cases (untracked files, reject residue) | intent-to-add; W3 unit tests + Shah Rukh/Snehal pairing; no-submodule-repos scoping | W3 dogfood diff missing a new file |
| Reject/resume context divergence | Hard rule in `Runs::Start`: reject severs claude_session_id; only revise resumes | — (correctness rule, encoded) |
| ActionCable auth/origin cross-machine (works on localhost, 403s/silently drops from other laptops) | Cookie-auth cable + explicit allowed origins for `.local`/LAN-IP; **cross-machine smoke end of W2, not deferred to the final week**; mDNS hostname in join URLs so DHCP changes don't break links | W2 Fri: REST works from Snehal's machine, cable won't subscribe |
| Aggressive 3-week pace (was 4 weeks) | Pre-agreed scope ladder; task board + terminal tab already cut; fixtures decouple streams; weekly milestones = pace checkpoints | Any milestone missed by >1 day → execute next ladder cut |
| Bus factor (Shah Rukh's machine) | Everything but live-Claude works anywhere via fixtures; W3 runbook; final verification run by non-Shah Rukh | Only Shah Rukh can restart the stack in W3 |

## 15. Verification

- **Two review gates bookend the build:** days 1–2 architecture review (plan challenged + SDK spike validates the riskiest assumption before any contract freezes) and W3 Thu–Fri complete project review (cross-stream code review, security checklist, cold docs walkthrough).
- **Weekly milestones** are the acceptance gates (W1 Rails+sidecar replay the fixture end-to-end + frontend scaffold exists → W2 live Claude + LAN cross-machine smoke + chat/presence/activity feed → W3 full approve/reject loop + README-driven cold start by Snehal/Manish).
- **Dogfood = highest-leverage QA**: from W3 onward, using clawdparty to build clawdparty with everyone on their own laptop over the LAN — exercises streaming, diff review, approval, and cross-machine networking simultaneously.
- Automated: CI green on the three jobs; system test proves prompt→events→changeset→approve→commit.

## 16. Engineering conventions

Conventions for this repo — chosen to keep a small MVP simple and consistent. These are standard Rails/React patterns; nothing here depends on any other codebase.

**Frontend:**
- **ActionCable client:** a connection-state Context bridged to React over `createConsumer("/~cable")`, using `@rails/actioncable` + `@types/rails__actioncable` directly (no GraphQL client layer). The buffer/backfill/drain cursor logic lives on top, in `web/src/lib/cable.ts`.
- **Vite config:** an ActionCable WS proxy (`"/~cable": { ws: true, target: ... }`) + a `/api` proxy to Rails; adopt the `/~cable` mount path. **The Docker twist:** since only `rails` is published, in dev the browser reaches the SPA *through* Rails (Rails reverse-proxies SPA + HMR to the unpublished `vite` container), so Vite also sets `server.host: true` + `server.hmr.clientPort: 3000` so the HMR WebSocket survives the proxy hop.
- **Biome:** formatter = 2-space, double quotes, semicolons; strict rules `noExplicitAny`, `useImportType`, `noConsole: error`. Single tool — no ESLint/Prettier.
- **TypeScript:** `strict: true`, `isolatedModules`, `jsx: react-jsx`, `forceConsistentCasingInFileNames: true`.
- **Vitest + MSW:** jsdom, `setupServer`, asset stubs, co-located `.test.tsx`.
- **Error boundary:** a `react-error-boundary`-based boundary (no Sentry wiring).
- **Component conventions:** `FC<Props>` components, snake_case filenames, flat `/hooks` + `/helpers`, nested provider composition (`web/src/providers/app_provider.tsx`).

**Backend:**
- **Cable connection auth:** `identified_by :current_user` + a `find_verified_user` lookup + `reject_unauthorized_connection`, where `find_verified_user` resolves the signed `clawd_uid` cookie.
- **Service-object style:** plain single-responsibility POROs under `app/services/` — e.g. `Runs::Start`, `Events::Ingest`, `Git::WorktreeManager`. No command/interactor framework — plain POROs are enough; if the `call`/validate/execute shape is ever wanted, a ~50-line `BaseOperation` can be extracted later.
- **Controller error rendering:** `rescue_from` → `render json: { errors: [...] }, status:`.
- **RSpec/FactoryBot:** one factory per model, `sequence` for uniqueness, minimal factories (no pre-created associations).
- **RuboCop baseline:** `rubocop-rails` + `rubocop-rspec`, `TargetRubyVersion` 4.0, max line 120, frozen string literals, `Style/MethodCallWithArgsParentheses: require_parentheses`.
- **annotaterb** for schema comments on models (nice-to-have, near-free).

**Authorization:** a single 4-role `SessionPolicy` PORO (owner/editor/reviewer/viewer), called in every controller action. No row/attribute-level authorization framework — the 4-role PORO is right-sized for this MVP.

**Deliberately out of scope (heavyweight for an MVP):** enforced modular package boundaries, an external/cloud job queue (we use Solid Queue), a Redis cable adapter (we use Solid Cable), a GraphQL stack (REST + the Contract-1 event envelope only), and legacy custom routers (we use React Router 6+ fresh).

## 17. Future phases (post-MVP backlog)

- **Remote access:** Tailscale (preferred) or Cloudflare Tunnel — rebind interface + allowed origins; no app-level changes expected.
- **Per-tool Bash gating:** activate the `canUseTool` seam in `sidecar/src/permissions.ts` for live approval of risky commands.
- **Monaco editor / collaborative editing** (CRDT/Yjs), multiplayer cursors.
- **Cloud-hosted sessions** with repo cloning and PR creation; local-agent mode for other developers' machines.
- **Codex worker support** as a second AI participant.
