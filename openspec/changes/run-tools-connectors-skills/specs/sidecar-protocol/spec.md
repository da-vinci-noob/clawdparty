## MODIFIED Requirements

### Requirement: Permission mode and tool scoping at run start

The contract SHALL specify that a run's `permission_mode` is a selectable allowlist value — `plan`, `acceptEdits` (the default when the field is omitted), or `bypassPermissions` — and that every run carries an `allowed_tools` whitelist and `cwd` pinned to the session worktree in all modes. `acceptEdits` auto-approves file edits within the whitelist (the prior fixed behavior); `plan` explores with read-only tools and does not make file edits; `bypassPermissions` auto-approves all tools and, per the SDK, is NOT constrained by `allowed_tools`, so Rails SHALL restrict it to owners (enforced server-side by `SessionPolicy`, not by the sidecar). Values outside the allowlist (including `default`/`dontAsk`/ask-per-tool) SHALL be rejected by Rails before reaching the sidecar. The `canUseTool` permission hook SHALL remain allow-all for the MVP and is documented as the seam for later per-tool Bash gating; live per-tool approval remains out of scope.

`POST /runs` SHALL additionally accept three additive, optional tool-scoping fields: `disallowed_tools` (string array of built-in tool ids to hard-disable), `connectors` (string array of host-configured MCP server names to enable), and `skills` (either `"all"` or an array of discovered skill names). Because `allowed_tools` only pre-approves (an omitted tool still falls through to the permission mode), `disallowed_tools` is the contract's mechanism for genuinely disabling a tool: the sidecar SHALL map it to the SDK `disallowedTools` (bare names), which removes those tools from context and applies **even under `bypassPermissions`** (deny rules always win). Each enabled connector name SHALL be resolved by the sidecar against host-owned configuration into an `mcpServers` entry with `mcp__<name>__*` appended to `allowed_tools`; the client SHALL never supply a server's command/url/headers. When `skills` is non-empty (or `"all"`) the sidecar SHALL set `settingSources` to include `user` and `project` and pass `skills` (which auto-adds the `Skill` tool); when omitted, skills are not enabled. All three fields default to today's behavior when omitted (nothing disabled, no connectors, no skills), and Rails SHALL reject any value outside the discovered/known sets with `422` before reaching the sidecar.

#### Scenario: Run start defaults to acceptEdits and pins cwd

- **WHEN** Rails starts a run without a `permission_mode`
- **THEN** the run carries `permission_mode: acceptEdits`, an `allowed_tools` whitelist, and `cwd` set to the session worktree

#### Scenario: A selected allowlist mode is honored

- **WHEN** Rails starts a run with `permission_mode: plan` (or `bypassPermissions`)
- **THEN** the sidecar starts the run in that mode with `cwd` still pinned to the session worktree

#### Scenario: A plan-mode run makes no file edits

- **WHEN** a run is started in `plan` mode
- **THEN** Claude explores with read-only tools and produces a plan without editing files, so no changeset is produced by that run

#### Scenario: disallowed_tools hard-disables a tool

- **WHEN** Rails starts a run with `disallowed_tools:["Bash"]`
- **THEN** the sidecar sets SDK `disallowedTools:["Bash"]` so Claude cannot use Bash in any permission mode, including `bypassPermissions`

#### Scenario: A connector name is resolved server-side to an MCP server

- **WHEN** Rails starts a run with `connectors:["github"]` for a host that has a `github` MCP server configured
- **THEN** the sidecar builds the `mcpServers` entry from host config and appends `mcp__github__*` to `allowed_tools`, and no server config crosses from the client

## ADDED Requirements

### Requirement: Sidecar capability discovery endpoints

The sidecar SHALL expose read-only, `cwd`-scoped discovery that Rails proxies to the client: `GET /connectors?cwd=<path>` and `GET /skills?cwd=<path>` (the built-in tool set is a shared contracts constant, not sidecar-discovered). Discovery SHALL read only host-owned configuration — the given repo path (`<cwd>/.mcp.json`, `<cwd>/.claude/skills/*/SKILL.md`) plus host-wide `~/.claude` — and SHALL NOT start a run. The connector listing SHALL expose only each server's `name` and `transport` (never command/args/url/headers/env/tokens); the skills listing SHALL be derived from scanning `SKILL.md` files and parsing their frontmatter (`name`, `description`). Each discovery response SHALL pin a success shape — `{ connectors: [...], source }`, `{ skills: [...], source }` — and SHALL degrade to an empty list with an unavailable `source` (never an error) when the underlying config is absent or unparseable, mirroring `GET /api/models`.

#### Scenario: Discovery reads the session repo config without starting a run

- **WHEN** Rails requests `GET /connectors?cwd=<path>` or `GET /skills?cwd=<path>` from the sidecar
- **THEN** the sidecar returns the host-configured names (connectors) or scanned skills for that path (plus `~/.claude`) without launching a `query()`/run

#### Scenario: Discovery degrades safely

- **WHEN** the given repo has no MCP config or skills directory, or the files are unparseable
- **THEN** the sidecar returns an empty list with an unavailable `source` and a `200`, never an error
