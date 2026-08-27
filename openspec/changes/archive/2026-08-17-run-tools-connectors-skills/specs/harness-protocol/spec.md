## MODIFIED Requirements

### Requirement: Permission mode and tool scoping at run start

`POST /runs` SHALL NOT carry a `permission_mode` or an `allowed_tools` field — both are removed — and
SHALL pin `cwd` to the session worktree in all modes. What a run may do SHALL be expressed as its
per-run TOOL SET, and the only thing that may refuse a call SHALL be the `tool:before` extension
point.

`permission_mode` was an Agent SDK concept — `plan`/`acceptEdits`/`bypassPermissions`, plus the
allow-all `canUseTool` hook that was documented as the seam for later per-tool gating and could not
intercept anything. The harness owns the loop and its own tool dispatch, so the mode has no meaning
here, and the retired seam was deleted rather than left exported: a seam that cannot intercept must
not exist. `allowed_tools` went with it, because it only ever pre-approved and so never disabled
anything.

`POST /runs` SHALL accept three additive, optional scoping fields, all defaulting to today's
behaviour when omitted (nothing disabled, no connectors, no skills):

- `disallowed_tools` — built-in tool ids to genuinely disable. The harness SHALL remove them from
  the tool set a run offers, so the model never sees them; this is the real disable, and the reason
  a pre-approval list was not.
- `connectors` — host-configured MCP server names. The harness SHALL resolve each name against
  host-owned configuration into an MCP server connection and expose its tools to the run. A
  server's command/args/url/headers/env SHALL NEVER cross from the client. A connector that is not
  configured, refuses, or hangs SHALL NOT fail the run: the run continues without it and
  `run_started` reports the failure by CLASSIFICATION (`not_configured`/`timeout`/`failed`), never
  the transport's own message, which could carry a URL with a token in it.
- `skills` — `"all"` or an array of discovered skill names. The harness SHALL index the selected
  skills in the system prompt and expose a `skill` tool that loads one on demand. Indexing rather
  than inlining is required, not stylistic: inlining every `SKILL.md` was never viable at real
  scale (79 on the measured host).

`run_started` SHALL echo the RESOLVED set — what the run actually applied, not what was requested —
because that event is the only place a client, including a late joiner arriving by backfill with no
live events, can learn what a run was allowed to do. Rails SHALL reject any value outside the
discovered/known sets with `422` before it reaches the harness.

#### Scenario: A run pins cwd to the session worktree

- **WHEN** Rails starts a run in either mode
- **THEN** the run's `cwd` is the session worktree and no permission mode is sent, because the field
  does not exist

#### Scenario: disallowed_tools removes the tool from the run entirely

- **WHEN** Rails starts a run with `disallowed_tools:["Bash"]`
- **THEN** the harness builds the run's tool set without `Bash`, so the model is never offered it,
  and `run_started` echoes `disallowed_tools:["Bash"]`

#### Scenario: A connector name is resolved server-side to an MCP server

- **WHEN** Rails starts a run with `connectors:["github"]` for a host that has a `github` MCP server
  configured
- **THEN** the harness connects to it from host-owned config and exposes its tools to the run, and no
  server configuration crosses from the client

#### Scenario: A broken connector does not break the run

- **WHEN** a selected connector is not configured on the host, refuses the connection, or hangs
- **THEN** the run proceeds without it and `run_started` lists it under `connectors_failed` with a
  classified `kind`, so the participant who enabled it is told rather than left to infer it from
  absence

#### Scenario: Skills are indexed, not inlined

- **WHEN** Rails starts a run with `skills:"all"`
- **THEN** the harness indexes the discovered skills in the system prompt and offers a `skill` tool
  that loads one on demand

## ADDED Requirements

### Requirement: Harness capability discovery endpoints

The harness SHALL expose read-only, `cwd`-scoped discovery that Rails proxies to the client:
`GET /connectors?cwd=<path>` and `GET /skills?cwd=<path>`. The built-in tool set is NOT discovered —
it is a shared `packages/contracts` constant, because it is the harness's own tool registry rather
than anything host-configured. Discovery SHALL read only host-owned configuration (the given repo
path plus host-wide `~/.claude`) and SHALL NOT start a run. Like every other harness route, both
SHALL require the bearer `HARNESS_SHARED_SECRET`: the harness binds host loopback, which every
process running as the developer can reach, so placement is not the boundary.

The connector listing SHALL expose only each server's `name` and `transport` — never
command/args/url/headers/env/tokens. The skills listing SHALL be derived from scanning `SKILL.md`
frontmatter (`name`, `description`). Each response SHALL pin a success shape
(`{ connectors: [...], source }`, `{ skills: [...], source }`) and SHALL degrade to an empty list
with an unavailable `source` and a `200` — never an error — when the configuration is absent or
unparseable, mirroring `GET /api/models`.

#### Scenario: Discovery reads the session repo config without starting a run

- **WHEN** Rails requests `GET /connectors?cwd=<path>` or `GET /skills?cwd=<path>` from the harness
- **THEN** the harness returns the host-configured connector names, or the scanned skills for that
  path plus `~/.claude`, without starting a run

#### Scenario: Discovery degrades safely

- **WHEN** the given repo has no MCP config or skills directory, or the files are unparseable
- **THEN** the harness returns an empty list with an unavailable `source` and a `200`, never an error

#### Scenario: Discovery is authenticated like everything else

- **WHEN** an unauthenticated process on the host calls `GET /connectors` or `GET /skills`
- **THEN** the harness answers `401`, because loopback is not the boundary
