## ADDED Requirements

### Requirement: Server-enforced role allowlist for opening a shell

The system SHALL gate every interactive-shell connection and write behind a `use_shell` permission enforced server-side in `api/` (`SessionPolicy`), never by the client hiding UI. The default allowlist SHALL be: `owner` always permitted; `editor` permitted **only** when the session's `shell_editor_access` opt-in is enabled (default disabled); `reviewer` and `viewer` NEVER permitted. This narrows — never widens — the frozen `http-api-contract` four-role matrix for this action. The permission SHALL be evaluated at connection time for the shell transport (§ "Shell stream transport") and on any REST control endpoint (§ "Shell lifecycle control endpoints"). A participant of the session whose role lacks `use_shell` SHALL be refused with `403` and a body of the form `{ errors: [...] }`; a non-participant or unknown session SHALL be refused `404` with `{ errors: [...] }`, indistinguishable from a nonexistent session (per `http-api-contract` anti-enumeration).

#### Scenario: Owner may open a shell

- **WHEN** an `owner` participant opens a shell for a session they belong to
- **THEN** the server permits it (the socket upgrade succeeds or the control endpoint returns its documented success shape), because `use_shell` is always granted to `owner`

#### Scenario: Editor is denied unless the session opt-in is enabled

- **WHEN** an `editor` participant attempts to open a shell while the session's `shell_editor_access` opt-in is disabled
- **THEN** the server refuses with `403` and a body `{ errors: [...] }`; and **WHEN** the owner has enabled `shell_editor_access`, the same editor request is permitted

#### Scenario: Reviewer and viewer are always denied

- **WHEN** a `reviewer` or `viewer` participant attempts to open or write to a shell, with the opt-in enabled or disabled
- **THEN** the server refuses with `403` and a body `{ errors: [...] }`, and no PTY is spawned

#### Scenario: Non-participant is refused indistinguishably from a nonexistent session

- **WHEN** a caller who is not a participant of the session (or names a session that does not exist) attempts a shell connection or control call
- **THEN** the server refuses with `404` and a body `{ errors: [...] }`, not distinguishing the two cases

### Requirement: Owner-controlled per-session editor shell opt-in

The system SHALL expose the `shell_editor_access` opt-in as owner-controlled session state, defaulting to disabled. It SHALL be readable and settable via an owner-gated endpoint (`manage`-class, owner-only). On success a set SHALL respond `200` with a JSON body `{ shell_editor_access: <boolean> }` reflecting the new value. A non-owner participant SHALL be refused `403` with `{ errors: [...] }`; a non-participant or unknown session SHALL be refused `404` with `{ errors: [...] }`. Disabling the opt-in while an editor holds a live shell SHALL cause that editor's subsequent writes/reconnects to be refused (the gate is re-evaluated, not cached at open time); the design MAY additionally terminate the live editor PTY on disable.

#### Scenario: Owner enables editor shell access

- **WHEN** an owner sets `shell_editor_access` to `true`
- **THEN** the response is `200` with `{ shell_editor_access: true }`, and editors of that session become eligible for `use_shell`

#### Scenario: Non-owner cannot change the opt-in

- **WHEN** an `editor`, `reviewer`, or `viewer` attempts to set `shell_editor_access`
- **THEN** the request is refused with `403` and a body `{ errors: [...] }`, and the value is unchanged

#### Scenario: Disabling revokes an editor's live access

- **WHEN** an owner disables `shell_editor_access` while an editor has an open shell
- **THEN** the editor's next write or reconnect is refused because the gate is re-evaluated server-side and no longer permits it

### Requirement: Shell stream rides a dedicated non-Contract-1 transport proxied through rails

The interactive-shell byte stream SHALL NOT be delivered as Contract-1 event envelopes and SHALL NOT ride the ActionCable `/~cable` mount. It SHALL use a dedicated WebSocket exposed by the unpublished shell host and reverse-proxied through the single published `rails` port at a distinct path (e.g. `/~shell/:session_id`), mirroring how `compose-networking` has `rails` front `/~cable` and proxy the Vite HMR socket; the shell host SHALL remain unpublished (compose-network only). The browser SHALL reach the shell only through the `rails` port. The frame protocol SHALL be minimal and explicit: client→server frames carry `stdin` bytes or a `resize` `{cols, rows}`; server→client frames carry `stdout` bytes or an `exit` `{code}`. This bespoke, off-cable protocol is the single sanctioned exception to the "all live state is a Contract-1 event" rule (see the `http-api-contract` MODIFIED delta) and SHALL be recorded in `docs/contracts/CHANGELOG.md`. The cable SHALL continue to carry only Contract-1 envelopes with no bespoke cable message types.

#### Scenario: Shell stream is off the cable

- **WHEN** shell stdout is streamed to a browser
- **THEN** it is delivered over the dedicated `/~shell` WebSocket as raw stdout frames, never as a Contract-1 event on `/~cable`, and no shell bytes are persisted in the event store

#### Scenario: Shell host stays unpublished and is reached only via rails

- **WHEN** a browser connects to a shell
- **THEN** it connects to the `rails` published port (e.g. `/~shell/:session_id`), which reverse-proxies to the unpublished shell host over the compose network; the shell host publishes no port to the host/LAN

#### Scenario: Cable remains pure Contract-1

- **WHEN** the shell feature is enabled and in use
- **THEN** the `/~cable` mount still carries only Contract-1 event envelopes and no bespoke cable message shape is introduced on the cable

### Requirement: Shell connection authenticated by the clawd_uid cookie

The shell WebSocket upgrade SHALL be authenticated by the same signed httpOnly `clawd_uid` cookie that authenticates REST and the cable (`http-api-contract`), with no separate token or query-string secret. The upgrade SHALL resolve the cookie (as `find_verified_user` does for the cable), verify the user is a participant of the target session, and apply the `use_shell` allowlist before any PTY is spawned or any byte is proxied. An unauthenticated or unverifiable connection SHALL be rejected at the handshake (connection refused), consistent with `reject_unauthorized_connection`. Invite revocation and role changes SHALL take effect for shells because the gate is evaluated at connect (and re-evaluated per the opt-in requirement), not cached from an earlier session.

#### Scenario: Unauthenticated upgrade is rejected

- **WHEN** a client attempts the `/~shell/:session_id` upgrade without a valid `clawd_uid` cookie
- **THEN** the handshake is rejected and no PTY is spawned

#### Scenario: Revoked participant cannot open a shell

- **WHEN** a participant whose invite has been revoked (or whose role was lowered below `use_shell`) attempts to open a shell
- **THEN** the connection is refused because authorization is evaluated at connect against current participantship/role

### Requirement: Credential confinement of the shell environment

The shell process SHALL NOT have the host's Claude/AWS credential directories available and SHALL NOT inherit the Claude/AWS auth environment. Specifically, the shell host SHALL NOT bind-mount `~/.claude` or `~/.aws` (unlike the SDK sidecar, per `claude-credential-mounts`), and the PTY environment SHALL have the credential-bearing variables scrubbed (at least `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `AWS_PROFILE`, `AWS_REGION`, and any other `ANTHROPIC_*`/`AWS_*`/`CLAUDE_CODE_*`). The specification acknowledges that read-only mounts do NOT prevent reading, so confinement is achieved by *not mounting* the credentials rather than by relying on mount read-onlyness. The shell host SHALL bind-mount only the target repo at the identical `/repo` path (per `compose-networking`) so worktree gitdir paths resolve. Residual reach (any host path the shell-host process user can read outside the not-mounted directories) SHALL be documented, not claimed eliminated.

#### Scenario: Credential directories are not mounted into the shell host

- **WHEN** the shell host service is configured
- **THEN** it mounts neither `~/.claude` nor `~/.aws`, so a shell cannot `cat` them, and it mounts only `/repo`

#### Scenario: Credential env is scrubbed from the PTY

- **WHEN** a PTY is spawned
- **THEN** its environment contains none of the `ANTHROPIC_*` / `AWS_*` / `CLAUDE_CODE_*` credential variables

### Requirement: Per-user PTY sessions with attribution and owner kill authority

Each authorized participant SHALL receive their own PTY, keyed by `(session_id, participant_id)`, capped at one live PTY per participant, with a per-session ceiling on total concurrent PTYs. A single shared PTY into which multiple users type SHALL NOT be used, so that every byte is attributable to exactly one participant. A participant MAY terminate their own PTY. An `owner` MAY terminate any PTY in the session. A non-owner SHALL NOT terminate another participant's PTY (refused `403` with `{ errors: [...] }`). The PTY `cwd` SHALL be pinned to the session worktree at spawn; the specification SHALL state that this is a starting directory, not a jail (the shell can `cd` elsewhere and reach anything the process user can).

#### Scenario: Each user gets their own attributable PTY

- **WHEN** two authorized participants each open a shell in the same session
- **THEN** each gets a distinct PTY keyed to their participant id, and no participant types into another's PTY

#### Scenario: Owner can kill any shell; a non-owner cannot kill another's

- **WHEN** an owner terminates another participant's PTY
- **THEN** it is terminated; and **WHEN** a non-owner attempts to terminate a PTY that is not theirs, the request is refused `403` with `{ errors: [...] }`

#### Scenario: PTY starts in the session worktree

- **WHEN** a PTY is spawned for a session
- **THEN** its initial `cwd` is the session's `clawd/session-<id>` worktree under `/repo`, understood as a starting directory and not an enforced boundary

### Requirement: Full input and output audit recording

The system SHALL record every shell session for after-the-fact review. It SHALL persist a shell-session record carrying at least `id`, `session_id`, `participant_id`, `role_at_open`, `opened_at`, `closed_at`, and `exit_code`, plus an ordered, timestamped, append-only transcript of BOTH stdin and stdout. Recording SHALL be performed server-side (by `rails` as it proxies, or shipped from the shell host to `rails` over the existing bearer-authed internal channel) so a client cannot suppress its own audit trail. Transcripts SHALL be readable only by an `owner` (or auditor role) of the session, refusing others `403`/`404` per the anti-enumeration rule, because a transcript MAY contain secrets a user deliberately printed.

#### Scenario: A shell session is recorded with attribution

- **WHEN** a participant opens a shell, runs commands, and disconnects
- **THEN** a shell-session record exists with their `participant_id`, `role_at_open`, timestamps, exit code, and an ordered stdin+stdout transcript

#### Scenario: Only an owner may read a transcript

- **WHEN** a non-owner participant requests a shell transcript
- **THEN** the request is refused (`403` for a participant lacking access, `404` for a non-participant/unknown session), each with a body `{ errors: [...] }`

### Requirement: Shell lifecycle and resource limits

Each PTY SHALL be bounded by an idle timeout (no I/O for a configured interval triggers `SIGTERM` then `SIGKILL`), a hard maximum session duration, and container/cgroup-level resource limits including a CPU share cap, a memory ceiling, and a pids limit (to blunt fork bombs). A WebSocket disconnect SHALL terminate the PTY and reap its process group (kill-on-disconnect), so a closed browser tab leaves no orphaned shell running. These limits SHALL be enforced on the shell host / its container, not merely via in-PTY `ulimit`.

#### Scenario: Disconnect kills the shell

- **WHEN** the shell WebSocket closes (tab closed, network drop)
- **THEN** the PTY is terminated and its process group reaped, leaving no orphan process

#### Scenario: Idle and max-duration limits terminate a shell

- **WHEN** a PTY exceeds its idle timeout or its hard maximum duration
- **THEN** the shell host terminates it (`SIGTERM` then `SIGKILL`) and records `closed_at`/`exit_code`

#### Scenario: Resource limits bound a runaway process

- **WHEN** a shell attempts to exhaust CPU, memory, or process ids
- **THEN** the container/cgroup limits (CPU share, memory ceiling, pids limit) bound the blast radius rather than starving the host

### Requirement: Shell lifecycle control endpoints

The system SHALL expose owner-and-participant REST control endpoints for shells, each gated by `SessionPolicy` and returning the `{ errors: [...] }` shape on failure. `GET /api/sessions/:session_id/shells` SHALL list active shells for the session — an `owner` sees all; a `use_shell` participant sees at least their own — responding `200` with a JSON array whose items carry `id`, `participant_id`, `opened_at`, and `status`, and never any transcript bytes. `DELETE /api/sessions/:session_id/shells/:id` SHALL terminate a shell (opener may terminate their own; owner may terminate any), responding `204` with no body on success, `403` when a non-owner targets another participant's shell, and `404` (anti-enumeration) for an id not in the target session or a session the caller is not a participant of. These control endpoints are ordinary REST; they do NOT carry shell bytes (which flow only over the dedicated transport).

#### Scenario: Listing active shells returns metadata only

- **WHEN** an authorized participant requests `GET /api/sessions/:session_id/shells`
- **THEN** the response is `200` with a JSON array of `{ id, participant_id, opened_at, status }` items and no transcript or stream bytes

#### Scenario: Terminating a shell over REST

- **WHEN** an owner sends `DELETE /api/sessions/:session_id/shells/:id` for an active shell
- **THEN** the response is `204` with no body and the PTY is terminated; and a non-owner targeting another's shell is refused `403`, while an id from another session yields `404`
