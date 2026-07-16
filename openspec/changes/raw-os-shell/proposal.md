## Why

Today the terminal pane is a **read-only replay of Claude's Bash events** — a load-bearing invariant stated verbatim in `CLAUDE.md` and `docs/PLAN.md §9`: *"There is no input path to a shell anywhere. Do not add one."* That is correct for the MVP. Phase 2 deliberately **reverses** it: a true interactive OS shell in the browser (type `ls`, `git status`, arbitrary commands) executed on the host in the session worktree and streamed live to the browser, so a driving participant can inspect and steer the environment Claude is working in without leaving the web UI.

Because it lets network peers run arbitrary host commands with the host developer's mounted credentials on a plain-HTTP LAN, this is the single most security-sensitive capability in the product. This change is a **design-only planning artifact** — it adds no application code. Its job is to make the security model explicit and reviewable *before* anyone builds it.

## What Changes

- **BREAKING (invariant reversal):** the read-only-terminal invariant is reversed for a strictly-gated subset of participants. Shipping this REQUIRES amending `CLAUDE.md` and `docs/PLAN.md §9` to qualify "no input path to a shell anywhere" with the new role/confinement constraints. That amendment is an implementation task here, not a silent edit — this planning change does not touch either file.
- **New interactive-shell capability** — a role-gated, per-user PTY spawned on the host in the session worktree, bidirectionally streamed to an `xterm.js` terminal in `web/`. Executed by a `node-pty` (or equivalent) shell host in the `sidecar/` stream (or a dedicated sibling service — see design), never in `api/`.
- **BREAKING (Contract-1 exception):** a raw stdin/stdout byte stream is **not** a Contract-1 event envelope. It rides a **dedicated transport outside the cable** (a WebSocket proxied through the `rails` published port, since the sidecar stays unpublished), explicitly carved out of the `http-api-contract` "all live state arrives as a Contract-1 event / no bespoke cable messages" rule. The cable itself stays pure Contract-1; the shell stream is a separate, documented exception recorded in `docs/contracts/CHANGELOG.md`.
- **Server-enforced role allowlist** — only `owner` (default) and, behind explicit per-session opt-in, `editor` may open or write to a shell; `reviewer` and `viewer` are refused at connection time. Enforced in `api/` (the shell socket is authenticated by the same signed `clawd_uid` cookie and gated by `SessionPolicy`), never by the client hiding a button.
- **Credential-confinement model** — the sidecar currently read-only-binds `~/.claude` + `~/.aws`; a shell can `cat` them. The design decides how shell sessions are confined (relocated/dropped credential mounts, a separate non-credentialed shell service, env scrubbing, constrained `cwd`) and is honest about residual reach.
- **Lifecycle + audit** — idle timeout, max duration, resource limits (CPU/mem/pids), kill/cleanup on disconnect, and full input+output session recording persisted for after-the-fact review (multi-user trust).

## Capabilities

### New Capabilities
- `raw-os-shell`: a role-gated, audited, resource-limited interactive host shell streamed to the browser over a dedicated non-Contract-1 transport, with a server-enforced role allowlist (owner-default, editor-opt-in, never reviewer/viewer), credential confinement of the shell's environment, per-user PTY lifecycle, and full session recording. Consumes `http-api-contract` (the 4-role matrix, cookie auth, `403`-vs-`404` rule), `compose-networking` (sidecar stays unpublished; the shell stream proxies through `rails`), `claude-credential-mounts` (the `~/.claude`/`~/.aws` read-only binds it must confine), and `worktree-management` (the session worktree it runs in) by name rather than re-deriving them.

### Modified Capabilities
- `http-api-contract`: the "All live state arrives as a Contract-1 event" requirement is narrowed. The cable rule is unchanged — the cable still carries only Contract-1 envelopes and no bespoke cable messages — but the requirement now explicitly acknowledges one sanctioned exception: the raw interactive-shell byte stream, which is NOT an event envelope and rides a dedicated transport **off** the cable. This is the only Contract-1 carve-out and is recorded in the contracts CHANGELOG.

## Impact

- **Invariants / docs** — reverses the `CLAUDE.md` / `docs/PLAN.md §9` "no shell input path" invariant (qualified, not deleted) and adds a `docs/contracts/CHANGELOG.md` entry documenting the Contract-1 exception + the new transport. Both are implementation tasks, not done in this planning change.
- **web/** — a new `xterm.js` terminal component with an input path and a WebSocket client; role-gated rendering (buttons hidden for under-privileged roles, but never the security boundary).
- **sidecar/ (or a new sibling service)** — a `node-pty` shell host: spawn/attach a PTY per user, bidirectional stream, lifecycle (idle/duration/resource limits, kill on disconnect), and environment confinement. The SDK-owning `sidecar/` may host it, or a dedicated **non-credentialed** shell service may be introduced (design decision) so the shell process never inherits the Claude/AWS mounts.
- **api/** — shell-socket connection authorization (cookie + `SessionPolicy` role allowlist, participantship verification), lifecycle control endpoints (open/close/list shells, per-session editor opt-in toggle), and audit persistence (input+output transcripts). Rails proxies the shell WebSocket to the unpublished shell host, mirroring how it fronts `/~cable`.
- **Contracts** — one `http-api-contract` MODIFIED delta (the Contract-1 carve-out) + a CHANGELOG entry. No change to the `event-envelope` taxonomy (the shell stream is not an event).
- **Out of scope** — per-command approval/gating of Claude's own Bash (unchanged; still allow-all via `permissions.ts`), a shell for `reviewer`/`viewer`, multi-command orchestration/scripting UI, and remote (non-LAN/Tailscale) exposure. Deferred until this design is reviewed.
