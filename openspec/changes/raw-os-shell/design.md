## Context

The MVP forbids any shell input path. `CLAUDE.md` and `docs/PLAN.md §9` both say verbatim: *"The terminal pane is a read-only replay of Claude's Bash events. There is no input path to a shell anywhere. Do not add one."* The activity feed's terminal output is a durable replay of Claude's `terminal_output` events; there is no PTY, no stdin, nowhere a byte typed by a human reaches a shell.

Phase 2 reverses that on purpose. A driving participant wants to type `git status`, `ls`, `rg`, `npm test` — inspect and steer the environment Claude is editing — without leaving the browser. That is genuinely useful and genuinely dangerous: the shell runs on the host, in the session worktree, as whatever user the shell-host process runs as, with the host developer's real Claude/AWS credentials mounted read-only nearby. The perimeter is a trusted-LAN, plain-HTTP deployment whose auth is a **reusable** invite link exchanged for a signed cookie (`invite-auth`, `http-api-contract`). "Reusable invite" + "arbitrary host command execution" is the crux of the threat model.

This document is **design only**. It commits no code and edits neither `CLAUDE.md` nor `docs/PLAN.md` — amending those is an implementation task (see `tasks.md`). It consumes, by name, the frozen `http-api-contract` (4-role matrix, `clawd_uid` cookie auth, `403`-vs-`404` anti-enumeration), `compose-networking` (only `rails` publishes a port; sidecar/vite unpublished; `rails` fronts the single port and reverse-proxies `/~cable`), `claude-credential-mounts` (the `~/.claude` + `~/.aws` read-only binds), and `worktree-management` (the `clawd/session-<id>` worktree). It contradicts exactly one existing requirement — `http-api-contract`'s "All live state arrives as a Contract-1 event" — and does so through a narrow, documented MODIFIED delta rather than silently.

## Goals / Non-Goals

**Goals:**
- A true interactive host shell (arbitrary commands) rendered in an `xterm.js` terminal in the browser, bidirectional, low-latency.
- A **server-enforced** role boundary: `owner` always; `editor` only behind explicit per-session opt-in; `reviewer`/`viewer` never — refused at socket connect, not merely hidden in the UI.
- A **confined credential surface**: the shell process must not trivially read the host's `~/.claude`/`~/.aws`; be explicit about what confinement does and does not buy on this platform.
- A transport decision that keeps the cable pure Contract-1 while carrying a raw byte stream, honoring `compose-networking` (sidecar stays unpublished; stream proxies through `rails`).
- Full **audit**: every shell's input and output recorded and attributable to a participant, for after-the-fact review in a multi-user session.
- A **lifecycle**: idle timeout, max duration, resource caps, and deterministic kill/cleanup on disconnect.

**Non-Goals:**
- Per-command live approval/gating of the shell (a human-in-the-loop "allow this command?" flow) — deferred; the boundary here is *who gets a shell at all*, not *which commands they run*.
- Any change to Claude's own Bash gating (`permissions.ts` stays allow-all) or to the read-only `terminal_output` replay.
- A shell for `reviewer`/`viewer`, shared-with-untrusted-parties operation, or remote/Tailscale exposure (still LAN-only).
- Hard OS-level jailing (chroot/namespaces/gVisor) as a *ship-blocking* requirement — evaluated as a Decision and an Open Question, not promised, because the host is a single developer's Mac under Docker Desktop.
- CRDT/multi-cursor editing, scrollback search UI, or shell "sessions marketplace" polish.

## Decisions

### D1 — Who may open a shell: owner-default, editor-opt-in, never reviewer/viewer (server-enforced)
The role allowlist is the primary control. `SessionPolicy` gains a `use_shell` permission. Default matrix:

| action | owner | editor | reviewer | viewer |
|---|:---:|:---:|:---:|:---:|
| open / write to a shell | ✓ | ✓ *(only if session opt-in enabled)* | ✗ | ✗ |

- **Owner** may always open a shell. **Editor** may only if the owner has flipped a per-session `shell_editor_access` opt-in (default **off**); with it off, editor is treated exactly like reviewer/viewer for shell purposes. **Reviewer/viewer** are never permitted.
- Enforcement is at the socket: the shell WebSocket upgrade runs `find_verified_user` (resolve `clawd_uid`) → verify session participantship → `authorize!(:use_shell, session)`. A participant lacking the permission is refused at connect (`403`); a non-participant or unknown session is refused indistinguishably (`404`, per `http-api-contract` anti-enumeration). The client hiding the terminal tab is cosmetic only.
- **Alternatives considered:** (a) owner-only, no opt-in — rejected as too rigid for the common two-owner-equivalent pairing case, but it is the safe default the opt-in defaults to. (b) editor-by-default — rejected: a leaked/over-shared editor invite would grant host command execution with no owner action; opt-in makes granting a deliberate act. (c) a fifth "operator" role — rejected as over-engineering for the MVP role model; a per-session boolean is right-sized.

### D2 — Transport: a dedicated WebSocket off the cable, proxied through `rails`
A PTY stream is raw bytes with resize/control frames — not an `{ id, session_id, ai_run_id, seq, type, actor, ts, payload }` envelope. Forcing it into Contract-1 (base64 chunks as `terminal_output`-shaped events, per-keystroke `seq`, persistence) would corrupt the event store, blow the `seq` space, and abuse the idempotency/backfill machinery. So the shell stream does **not** ride the cable.

- The shell host exposes a WebSocket; `rails` reverse-proxies it on its single published port at a distinct path (e.g. `/~shell/:session_id`), exactly mirroring how `compose-networking` has `rails` front `/~cable` and proxy the Vite HMR socket — the sidecar/shell-host stays **unpublished** (compose-network only). The browser only ever talks to `rails:3000`.
- Frame protocol on that socket is minimal and explicit: client→server `{stdin: bytes}` and `{resize: {cols, rows}}`; server→client `{stdout: bytes}` and `{exit: {code}}`. This is a **bespoke, non-Contract-1** protocol, permitted only here.
- The cable stays pure: the existing 20+ Contract-1 event types and the "no bespoke cable messages" rule are untouched. `http-api-contract` is amended (MODIFIED delta) only to *acknowledge* this one off-cable exception, so the contract does not lie.
- Lightweight, non-byte-stream shell **lifecycle** notifications (a shell opened/closed, who is attached) MAY still be modeled as ordinary Contract-1 events on the cable if the UI needs them, keeping "presence"-style state on the cable while the byte stream stays off it. Whether to add such event types is deferred (see Open Questions) and would be a separate additive contract change, not part of this exception.
- **Alternatives considered:** (a) a binary ActionCable channel — rejected: it puts a non-envelope stream *on the cable*, directly violating the one-transport rule and coupling shell backpressure to the event fan-out; a separate socket isolates failure and backpressure. (b) publishing the shell host's port directly to the LAN — rejected: violates `compose-networking` ("only `rails` publishes a port") and bypasses the cookie/role gate. (c) SSE — rejected: unidirectional, no clean stdin path.

### D3 — Where the shell runs: a dedicated non-credentialed shell service, not the SDK sidecar
The `sidecar/` process deliberately inherits the host's Claude/AWS auth (env + `~/.claude`/`~/.aws` read-only binds) — that is `claude-credential-mounts`/`claude-auth-passthrough` by design. Spawning user shells *inside that same process* hands every shell those mounts and that env. So the shell host is a **separate compose service** (`shell-host`, unpublished) that:
- does **not** bind `~/.claude` or `~/.aws`,
- does **not** inherit the Claude/AWS auth env (`ANTHROPIC_*`, `AWS_*`, `CLAUDE_CODE_*` are scrubbed from the PTY's environment),
- bind-mounts only the target repo at the identical `/repo` path (per `compose-networking`, so worktree gitdir paths resolve), read-write like the sidecar's repo mount.
- **Alternatives considered:** (a) host the PTY in the existing sidecar with per-PTY env scrubbing and no credential-dir access — rejected as the default because "the credentials are mounted but we promise not to read them" is one bug away from exfiltration; a service that never mounts them cannot leak them. Env scrubbing alone does not remove the *file* mounts. (b) a fully separate container image with a minimal base — folded into (a): the dedicated service is where hardening (resource limits, minimal tooling) naturally lives. The trade-off is one more compose service and a second repo mount; acceptable for the security gain. This choice is a Decision, but its final form (separate service vs. hardened in-sidecar) is confirmed at build time against how heavy the sidecar image already is (noted as a dependency, not finalized code here).

### D4 — cwd confinement and honest residual reach
The PTY starts with `cwd` pinned to the session worktree (`clawd/session-<id>`). We do **not** claim the shell is jailed to the worktree: `cd /`, absolute paths, and reads of anything the shell-host process user can reach remain possible. Mitigations layer up (see Risks): run the shell host as a low-privilege non-root user, mount only `/repo`, drop Linux capabilities, and — as an Open Question — evaluate an OS boundary (a restricted user, a chroot, or a container-in-container). The design is explicit that on macOS Docker Desktop these boundaries are softer than on Linux, and states the residual risk rather than papering over it.

### D5 — Concurrency: per-user PTYs, not one shared shell
Each authorized participant who opens a shell gets **their own** PTY (`shell` keyed by `(session_id, participant_id)`, capped at one live PTY per participant, with a per-session ceiling on total PTYs). A shared single PTY where everyone types into the same interleaved shell is rejected: it makes attribution impossible (who ran `rm -rf`?), lets one user's keystrokes corrupt another's command, and muddies audit. Per-user PTYs give clean attribution (every recorded byte maps to one participant id) and independent lifecycles.
- **Kill authority:** a participant may kill their own PTY; an **owner** may kill any PTY in the session (documented as an owner power). Non-owners cannot kill others' shells.
- **Visibility:** whether other participants can *watch* (read-only) another user's live shell is an Open Question; the default is private-to-opener + owner, since read-only spectating of a shell is a smaller feature that can follow.
- **Alternatives considered:** shared PTY (rejected, above); tmux-style shared-with-attribution (rejected as too heavy for the MVP and still poor for audit).

### D6 — Audit: full input+output recording, persisted, attributable
Multi-user trust on a plain-HTTP LAN demands after-the-fact review. Every PTY session is recorded: a `shell_sessions` row (`id`, `session_id`, `participant_id`, `role_at_open`, `opened_at`, `closed_at`, `exit_code`, resource/limit metadata) plus an append-only transcript of **both** stdin and stdout (timestamped, ordered), stored so an owner/auditor can replay what a participant did. Recording is server-side (Rails persists what it proxies, or the shell host ships a transcript to Rails over the existing bearer-authed internal channel) so a malicious client cannot suppress its own audit trail.
- Transcripts may contain secrets a user deliberately `cat`s; they inherit the same file-safety posture as the repo and are owner/auditor-only. This is called out as a trade-off, not hidden.
- **Alternatives considered:** input-only logging (rejected: output is where exfiltration shows up); no persistence / ring-buffer only (rejected: defeats after-the-fact review, the whole point in a multi-user session).

### D7 — Lifecycle & resource limits
Each PTY has: an **idle timeout** (no I/O for N minutes → SIGTERM then SIGKILL), a **max session duration** (hard cap regardless of activity), **resource limits** (CPU shares, memory ceiling, and a **pids limit** to blunt fork bombs — enforced at the container/cgroup level on the dedicated shell service, not just `ulimit` inside the PTY), and **kill-on-disconnect** (WebSocket close → terminate the PTY and reap the process group, so a closed browser tab never leaves an orphan shell running with the tab's credentials-adjacent reach). Reconnect within a short grace window MAY reattach to a still-live PTY (Open Question); the safe default is disconnect ⇒ kill.

### D8 — Auth reuse, not a new mechanism
The shell socket is authenticated by the **same** signed httpOnly `clawd_uid` cookie that authenticates REST and the cable (`http-api-contract`). No new token, no query-string secret. The upgrade handshake resolves the cookie, verifies participantship, and applies `use_shell` — reusing `find_verified_user`/`reject_unauthorized_connection` semantics. This keeps one auth surface and means invite revocation (`invite-auth`) and role changes take effect for shells too.

## Risks / Trade-offs

- **[Arbitrary host command execution by a network peer holding a reusable invite]** → Server-enforced `use_shell` allowlist (owner-default, editor-opt-in, never reviewer/viewer) applied at socket connect (D1); auth via the same revocable `clawd_uid` cookie (D8); default opt-in **off** so granting a shell to editors is a deliberate owner action; full audit (D6) so misuse is attributable. Residual: anyone the owner *does* grant can run arbitrary commands — the LAN perimeter and single-developer-credential posture (`docs/PLAN.md §9`) is the accepted boundary, now made narrower, not wider, than Claude's own already-arbitrary Bash.
- **[Credential exfiltration — a shell `cat`s `~/.aws`/`~/.claude`]** → The shell runs in a **dedicated service that never mounts those directories and scrubs the Claude/AWS auth env** (D3); read-only mounts do **not** prevent reading, so the only real mitigation is *not mounting them* — stated honestly. Residual: any credential reachable by the shell-host process user on the host filesystem (outside the not-mounted dirs) is still readable; mounting only `/repo` and running as a low-privilege user shrinks but does not eliminate this.
- **[cwd confinement escape — `cd /`, absolute paths]** → `cwd` pinned to the worktree is a convenience, not a jail (D4); layered mitigations: low-privilege non-root user, only `/repo` mounted, dropped capabilities, pids/memory/CPU caps (D7). Residual: the shell reaches anything the process user can; a hard OS jail (chroot/namespaces) is an Open Question, softer on macOS Docker Desktop than Linux — documented, not promised.
- **[New bidirectional transport breaks the frozen "everything live is a Contract-1 event" rule]** → The stream rides a **dedicated WebSocket off the cable** (D2), so the cable stays pure Contract-1; `http-api-contract` is amended via a narrow MODIFIED delta that *acknowledges* the single exception, and `docs/contracts/CHANGELOG.md` records it. Residual: there are now two live transports to reason about; mitigated by keeping the shell protocol tiny, isolated, and off the event store.
- **[Multi-user interleaving / unattributable actions in one shared shell]** → Per-user PTYs keyed by participant (D5); every recorded byte maps to one participant id (D6); owner-only cross-kill. Residual: N shells cost N PTYs and N transcripts — bounded by the per-session PTY ceiling and resource caps (D7).
- **[Orphaned shells outliving the browser tab / DoS via fork bomb or runaway process]** → Kill-on-disconnect with process-group reaping, idle timeout, max duration, and cgroup-level CPU/memory/**pids** limits on the dedicated service (D7). Residual: a determined user can still burn their capped budget; caps bound blast radius, they don't prevent misuse.
- **[Sidecar-hosted PTY would inherit Claude/AWS auth]** → Avoided by the dedicated non-credentialed shell service (D3) rather than trusting in-process env scrubbing next to live credential mounts.
- **[Audit transcript itself leaks secrets a user printed]** → Transcripts are owner/auditor-only, same file-safety posture as the repo; the alternative (not recording output) is worse because output is where exfiltration is visible (D6). Residual: a printed secret is now in two places (the shell and the transcript) — accepted for the audit value, flagged for the reviewer.
- **[Plain-HTTP LAN — shell bytes and cookie travel unencrypted]** → Same accepted posture as the rest of the app (`docs/PLAN.md §9`: trusted LAN, no `Secure` cookie flag); a network sniffer on the LAN already sees everything. Residual: a shell stream is higher-value to sniff than chat; TLS/Tailscale is the future-phase mitigation, not part of this LAN MVP.

## Migration Plan

This is a planning change; there is no code to deploy. The path to shipping (sequenced in `tasks.md`) is: (1) a security review of this design as the gate before any build; (2) amend `CLAUDE.md` + `docs/PLAN.md §9` to reverse/qualify the invariant with the role/confinement constraints; (3) add the `http-api-contract` Contract-1-exception delta + the `docs/contracts/CHANGELOG.md` entry; (4) build the dedicated shell service, the `rails` proxy + authz, audit persistence, lifecycle, and the `web/` terminal, each with tests; (5) verify the role gate, credential confinement, and audit end-to-end before enabling for anyone but owner. Rollback is feature-flag-clean: the capability is additive and off by default (editor opt-in off; the terminal-input UI gated), so disabling the flag and closing the `/~shell` route restores the read-only-terminal MVP with no data migration.

## Open Questions

- **OS-level jail:** do we ship with just a low-privilege user + minimal mounts + cgroup caps, or invest in a chroot/namespace/container-in-container boundary given macOS Docker Desktop's softer isolation? (Affects D4.)
- **Read-only spectating:** may other authorized participants *watch* another user's live shell, or is a PTY strictly private-to-opener + owner? (Affects D5.)
- **Reconnect grace:** does a dropped WebSocket kill the PTY immediately (safe default) or allow reattach within a short window? (Affects D7.)
- **Shell lifecycle on the cable:** do we add Contract-1 event type(s) for "shell opened/closed/attached" so the UI shows who has a shell, or keep all shell state off the cable? (An additive contract change if yes — separate from the D2 exception.)
- **Dedicated service vs. hardened in-sidecar:** final form of D3 depends on the built sidecar image's size/toolchain at implementation time — stated as a dependency, not finalized here.
