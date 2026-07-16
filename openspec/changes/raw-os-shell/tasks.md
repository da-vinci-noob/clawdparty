## 1. Security review gate (blocks all implementation)

- [ ] 1.1 Hold a dedicated security review of this design (`proposal.md` + `design.md` + specs) as the gate before ANY implementation work below begins. Scope: the role allowlist (owner-default / editor-opt-in / never reviewer-viewer), credential confinement (D3), cwd/OS confinement (D4), the off-cable transport exception (D2), audit (D6), and lifecycle/limits (D7). Record the outcome (approve / approve-with-conditions / reject).
- [ ] 1.2 Resolve the design's Open Questions that the review flags as ship-blocking (OS-level jail posture, read-only spectating, reconnect-grace, whether shell lifecycle gets Contract-1 event types, dedicated-service vs. hardened-in-sidecar). Everything in groups 2–9 is BLOCKED until 1.1 approves.

## 2. Invariant + contract amendments (do first once the gate approves)

- [ ] 2.1 Amend `CLAUDE.md`: reverse/qualify the "The terminal pane is a read-only replay of Claude's Bash events. There is no input path to a shell anywhere. Do not add one." invariant to state the sanctioned, role-gated, credential-confined, audited shell input path and its constraints (owner-default / editor-opt-in / never reviewer-viewer; dedicated off-cable transport; non-credentialed shell host).
- [ ] 2.2 Amend `docs/PLAN.md §9` (and the `§12` scope notes if relevant) to match the amended invariant, keeping the plan the source of truth.
- [ ] 2.3 Add a `docs/contracts/CHANGELOG.md` entry documenting (a) the Contract-1 exception — the raw shell byte stream is the single sanctioned off-cable live transport, cable stays pure Contract-1 — and (b) the new `/~shell/:session_id` transport + its frame protocol, with the appropriate version classification and rationale.
- [ ] 2.4 Apply the `http-api-contract` MODIFIED delta from this change to `docs/contracts/http_api.md` (and any mirrored contract doc), narrowing "all live state is a Contract-1 event" to acknowledge the shell-stream exception without changing the cable rule.

## 3. Shell host service (dedicated, non-credentialed)

- [ ] 3.1 Add the shell-host compose service (unpublished, compose-network only per `compose-networking`): bind-mount ONLY the target repo at `/repo`; do NOT mount `~/.claude` or `~/.aws`; do NOT inherit the Claude/AWS auth env; run as a low-privilege non-root user with dropped capabilities.
- [ ] 3.2 Implement PTY spawn via `node-pty` (or equivalent): one PTY per `(session_id, participant_id)`, `cwd` pinned to the session `clawd/session-<id>` worktree, environment scrubbed of `ANTHROPIC_*` / `AWS_*` / `CLAUDE_CODE_*`.
- [ ] 3.3 Expose the WebSocket + frame protocol (client→server `stdin` / `resize {cols,rows}`; server→client `stdout` / `exit {code}`); enforce the per-session PTY ceiling and one-PTY-per-participant cap.
- [ ] 3.4 Implement lifecycle: idle timeout (`SIGTERM`→`SIGKILL`), hard max duration, kill-on-disconnect with process-group reaping; configure container/cgroup CPU share, memory ceiling, and pids limit.
- [ ] 3.5 Ship each session's stdin+stdout transcript + shell-session metadata to Rails over the existing bearer-authed internal channel (or the equivalent server-side capture point).

## 4. Rails — authorization, proxy, control endpoints, audit

- [ ] 4.1 Add the `use_shell` permission to `SessionPolicy` with the allowlist: owner always; editor iff `shell_editor_access`; never reviewer/viewer.
- [ ] 4.2 Reverse-proxy the shell WebSocket at `/~shell/:session_id` through the single published `rails` port to the unpublished shell host (mirroring the `/~cable` + Vite-HMR proxy), authenticating the upgrade with the signed `clawd_uid` cookie (`find_verified_user`) + participantship + `use_shell`, rejecting unauthenticated/under-privileged connections at the handshake.
- [ ] 4.3 Add the owner-gated `shell_editor_access` opt-in state + read/set endpoint (`200 { shell_editor_access }` on set; `403`/`404` otherwise); re-evaluate the gate on write/reconnect so disabling revokes a live editor.
- [ ] 4.4 Add `GET /api/sessions/:session_id/shells` (list active shells, metadata only, no bytes) and `DELETE /api/sessions/:session_id/shells/:id` (opener kills own, owner kills any; `204` / `403` / `404`).
- [ ] 4.5 Persist the `shell_sessions` model + append-only timestamped stdin/stdout transcript; add an owner/auditor-only transcript read path (refusing others per anti-enumeration). Add a minimal factory.

## 5. Web — terminal UI

- [ ] 5.1 Add the `xterm.js` terminal component with an input path and a WebSocket client to `/~shell/:session_id`, wired to the frame protocol (stdin/resize out, stdout/exit in).
- [ ] 5.2 Role-gate the terminal-tab and open/close controls on the client (owner always; editor only when the session opt-in is on) — cosmetic only; never the security boundary.
- [ ] 5.3 Add an owner-only session control to toggle `shell_editor_access`, and a shells list showing who has a live shell with an owner "kill" affordance.

## 6. Security & confinement verification

- [ ] 6.1 Verify credential confinement: from inside a live shell, confirm `~/.claude`/`~/.aws` are absent and the credential env vars are unset; confirm the shell host mounts neither.
- [ ] 6.2 Verify the shell host publishes no port and is reachable only via the `rails` proxy; confirm the cookie/role gate cannot be bypassed by connecting directly on the compose network from a browser.
- [ ] 6.3 Verify kill-on-disconnect, idle/max-duration termination, and cgroup CPU/memory/pids caps with a runaway-process probe; confirm no orphan PTY survives a dropped socket.

## 7. Tests — backend

- [ ] 7.1 `SessionPolicy` specs for `use_shell`: owner allowed; editor allowed only with opt-in on; reviewer/viewer always denied.
- [ ] 7.2 Request specs for `shell_editor_access` set/read (owner `200`, non-owner `403`, non-participant/unknown `404`) and for `GET`/`DELETE /shells` (metadata-only list; opener-vs-owner kill authority; cross-session `404`).
- [ ] 7.3 Shell-socket authorization specs: unauthenticated upgrade rejected; revoked/lowered participant refused at connect; reviewer/viewer refused.
- [ ] 7.4 Audit specs: a shell session persists attribution + ordered stdin/stdout transcript; transcript read is owner/auditor-only.

## 8. Tests — shell host & web

- [ ] 8.1 Shell-host unit tests (Vitest): env scrubbing removes all credential vars; PTY keyed per participant with the per-session ceiling; idle/max-duration/disconnect lifecycle terminates and reaps.
- [ ] 8.2 Web tests (Vitest + RTL + MSW): terminal renders for authorized roles and is hidden for under-privileged roles; stdin frames are sent and stdout frames render; the editor toggle and shells-list/kill controls are owner-gated.

## 9. Final verification

- [ ] 9.1 `openspec validate raw-os-shell` passes; run the api RSpec + RuboCop, sidecar/shell-host + web Biome/tsc/Vitest suites green.
- [ ] 9.2 End-to-end confinement + role + audit walkthrough on the LAN (owner opens a shell, editor blocked until opt-in, reviewer/viewer blocked, transcript recorded, disconnect kills the PTY) before enabling for anyone but owner.
