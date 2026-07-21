## ADDED Requirements

### Requirement: Host-owned capability discovery

The system SHALL let the client discover the tools, connectors, and skills available to a run, read-only, sourced entirely from the host. The built-in **tools** are a fixed set that never varies by host or repo; they SHALL be a shared constant in the contracts package (`Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, each with a label + description) consumed directly by the client and by Rails validation — there SHALL be no tools discovery endpoint.

Connectors and skills are per-repo project artifacts, and the repo is per-session, so their discovery SHALL be **session-scoped** and read by the sidecar (the only component that reads host config) against the session's repository path plus host-wide `~/.claude`:

- `GET /api/sessions/:id/connectors` SHALL respond `200` with `{ connectors: [{ name, transport }], source }`, enumerating only MCP servers the host has configured for that session's repo (`<cwd>/.mcp.json`) or user-wide, and SHALL expose **only** `name` and `transport` — never the server's command, args, url, headers, env, or tokens.
- `GET /api/sessions/:id/skills` SHALL respond `200` with `{ skills: [{ name, description }], source }` discovered by scanning `<cwd>/.claude/skills/*/SKILL.md` and `~/.claude/skills/*/SKILL.md`; the length of `skills` is the real skill count.
- When a source is missing or unparseable, the corresponding list SHALL be empty (`source` marking it unavailable) with a `200`; when the sidecar is unreachable the proxy SHALL respond `502` (matching `GET /api/models`), not a fabricated empty list. A cross-session/non-participant request SHALL be refused `404 { errors: [...] }`.

#### Scenario: The built-in tool set is a shared constant, not an endpoint

- **WHEN** the client renders the Tools list or Rails validates `disallowed_tools`
- **THEN** both read the same shared built-in constant (`Read`/`Write`/`Edit`/`Bash`/`Glob`/`Grep`/`WebSearch`/`WebFetch`), and no `/api/tools` request is made

#### Scenario: Connector discovery is session-scoped and never leaks host config secrets

- **WHEN** a participant calls `GET /api/sessions/:id/connectors` and the host has configured MCP servers for that session's repo
- **THEN** the response lists each server's `name` and `transport` only, resolved from that session's repository path, and contains no command/args/url/headers/env/token

#### Scenario: Missing config yields an empty list; an unreachable sidecar yields 502

- **WHEN** the session's repo has no `.mcp.json`/skills directory (empty+unavailable, `200`) versus the sidecar being unreachable (`502`)
- **THEN** the endpoint distinguishes the two — an empty list with unavailable `source` for missing config, and `502` when the sidecar cannot be reached

### Requirement: Per-run capability selection at run start

Run start (`POST /api/sessions/:id/runs`, owned by `run-control-api`) SHALL accept optional additive body fields `disallowed_tools` (string array of built-in tool ids to turn OFF), `connectors` (string array of host-configured server names to enable), and `skills` (either the string `"all"` or an array of discovered skill names). When a field is omitted the run SHALL behave exactly as today: nothing disabled, no connectors, no skills. On success the endpoint SHALL return the existing `202` shape (`{ id, status }`) unchanged.

Rails SHALL validate each field against the discovered/known sets before starting the run: `disallowed_tools` ⊆ the known built-in tool ids, `connectors` ⊆ the host-discovered connector names, and `skills` either `"all"` or ⊆ the discovered skill names. Any unknown or non-selectable value SHALL be rejected with `422` and a body of the form `{ errors: [...] }`, and no run SHALL be started. Selecting these controls SHALL be gated to run-capable roles (owner/editor) exactly like starting a run; a reviewer/viewer attempt SHALL be denied `403 { errors: [...] }` per the four-role matrix, and `bypassPermissions` SHALL remain owner-only.

#### Scenario: Omitted fields preserve today's behavior

- **WHEN** an editor starts a run without `disallowed_tools`, `connectors`, or `skills`
- **THEN** the run starts with nothing disabled, no connectors, and no skills — identical to the prior behavior

#### Scenario: A valid selection is accepted

- **WHEN** an editor starts a run with `disallowed_tools:["Bash"]`, `connectors:["<a host-configured name>"]`, and `skills:["<a discovered name>"]`
- **THEN** the server responds `202` with `{ id, status }` and the selection is threaded to the sidecar

#### Scenario: An unknown value is rejected before the run starts

- **WHEN** a run start includes a tool id, connector name, or skill name not in the discovered/known set
- **THEN** the server responds `422` with `{ errors: [...] }` and starts no run

#### Scenario: Non-run roles cannot set capabilities

- **WHEN** a reviewer or viewer attempts to start a run (with or without capability fields)
- **THEN** the server responds `403 { errors: [...] }` regardless of what the client UI shows

### Requirement: Capability selection maps to Agent SDK options

The sidecar SHALL map the run-start payload to `query()` options such that an OFF tool is genuinely unavailable, not merely un-pre-approved. `disallowed_tools` SHALL be passed as `disallowedTools` (bare tool names), which removes those tools from the model's context and applies even under `bypassPermissions`. The base `allowed_tools` pre-approval set SHALL be preserved (unchanged default). Each enabled connector name SHALL be resolved against the host config into an `mcpServers` entry, and `mcp__<name>__*` SHALL be appended to `allowedTools`. When `skills` is non-empty (or `"all"`), the sidecar SHALL set `settingSources` to include `"user"` and `"project"` and pass `skills`; when omitted/empty, skills SHALL NOT be enabled and the `Skill` tool SHALL NOT be added. `cwd` SHALL remain pinned to the session worktree in all cases.

#### Scenario: An OFF tool is removed via disallowedTools

- **WHEN** a run is started with `disallowed_tools:["Bash"]`
- **THEN** the sidecar sets `disallowedTools:["Bash"]` on `query()` so Claude cannot use Bash, even if the permission mode would otherwise auto-approve it

#### Scenario: An enabled connector becomes usable and allowed

- **WHEN** a run is started with `connectors:["github"]` and the host has a `github` MCP server configured
- **THEN** the sidecar adds that server to `mcpServers` and appends `mcp__github__*` to `allowedTools`

#### Scenario: Skills are enabled only when selected

- **WHEN** a run is started with a non-empty `skills` (or `"all"`)
- **THEN** the sidecar sets `settingSources` to include user+project and passes `skills`; and when `skills` is omitted, no skills and no `Skill` tool are enabled

### Requirement: run_started echoes the applied capabilities

The `run_started` event payload (owned by the event-envelope/contracts capabilities) SHALL additively carry optional `disallowed_tools`, `connectors`, and `skills` reflecting what the run actually applied, so participants — including late joiners via REST backfill — can see a run's real capabilities. No new event type SHALL be introduced; the Contract-1 taxonomy is unchanged.

#### Scenario: The run banner reflects the real capabilities

- **WHEN** a run starts with a capability selection and a participant (including one who joins mid-run) receives the `run_started` event
- **THEN** the payload carries the applied `disallowed_tools`/`connectors`/`skills`, and the run banner can display what the run used

### Requirement: Capabilities are host-owned; the browser selects names only

The browser SHALL only ever send tool ids, connector names, and skill names — never a connector command, url, headers, env, or any executable configuration. The sidecar SHALL resolve every connector purely from host-owned, read-only configuration; a server not present in the host config SHALL be unusable from the UI (rejected by Rails with `422`). This mirrors the invariant that Claude/AWS auth is the host's and never app-owned.

#### Scenario: A client-supplied server config is not honored

- **WHEN** a run-start request includes a connector name that is not host-configured, or attempts to supply a raw server config
- **THEN** the server rejects the unknown name with `422` and never constructs an MCP server from client-supplied command/url/header data
