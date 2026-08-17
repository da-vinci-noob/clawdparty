## Why

The composer's "Tools / Connectors" panel and the "✦ Skills 3" button are a static mock: the toggles hold local React state only, the "3" is a hardcoded literal, and nothing from that surface reaches a run. Only `model` and `permission_mode` actually flow to Claude today. Users see controls that imply they can shape what Claude may do, but the controls are inert — so a viewer cannot trust or reason about a run's real capabilities. This change makes the surface real and per-run: the tools a run may use, the MCP connectors it may reach, and the skills it may invoke all become genuine, discovered from the host, chosen per run, and echoed back so everyone sees what a run actually ran with.

## What Changes

- **Discovery (read-only, host-owned):**
  - **Tools** — the canonical built-in set (`Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `WebSearch`, `WebFetch`) is a **static shared constant in `packages/contracts`** (no endpoint — it never varies by host/repo), consumed by the web picker and by Rails validation; all default-ON (today's behavior).
  - `GET /api/sessions/:id/connectors` — MCP servers **the host already configured**, discovered by the sidecar scanning the session's repo (`<cwd>/.mcp.json`) plus host-wide `~/.claude`, returning name + transport only; default-OFF. **Session-scoped** because `.mcp.json` is a per-repo file and the repo is per-session.
  - `GET /api/sessions/:id/skills` — skills discovered by the sidecar scanning `<cwd>/.claude/skills/*/SKILL.md` and `~/.claude/skills/*/SKILL.md` and parsing frontmatter (name, description); the real count replaces the hardcoded "3". Session-scoped for the same reason.
  - Both session-scoped endpoints are proxied + cached like `GET /api/models` (cache key includes the repo path), gate on participantship, and `502` when the sidecar is unreachable (matching `ModelsController`).
- **Per-run selection sent on run start** (`POST /api/sessions/:id/runs`): additive body fields `disallowed_tools` (the built-ins toggled OFF), `connectors` (enabled server names), `skills` (enabled skill names or `"all"`). Validated server-side against the discovered/allowlisted sets; unknown values → **422**. Selecting these is gated to run-capable roles (owner/editor); `bypassPermissions` stays owner-only.
- **SDK mapping (sidecar `buildOptions`):** OFF tools → `disallowedTools` (bare name — the *only* true disable; `allowedTools` merely pre-approves); enabled connectors → `mcpServers` (resolved from host config) plus `mcp__<server>__*` appended to `allowedTools`; selected skills → `settingSources:["user","project"]` + `skills:[…]`. `cwd` stays pinned to the worktree in all modes.
- **Echo for honesty + late-joiners:** `run_started` payload gains additive optional `disallowed_tools?` / `connectors?` / `skills?` so the run banner shows what the run actually used. **No new event type** — the Contract-1 taxonomy is unchanged.
- Replace the mock in `web/src/components/session/skills_popover.tsx` and the hardcoded badge in `prompt_composer.tsx` with discovered lists, wired to the run-start POST; role-gate the controls.
- **Documented (non-envelope) contract changes** with a `docs/contracts/CHANGELOG.md` entry; update the CLAUDE.md run-start line.

## Capabilities

### New Capabilities
- `run-capability-selection`: discovery of host-owned tools/connectors/skills, per-run selection of them at run start (validation, role-gating, defaults), their mapping to Agent SDK `query()` options in the sidecar, and the `run_started` echo. Consumes `session-run-modes` (permission_mode) and `run-control-api` (run-start endpoint + role matrix) by name rather than re-deriving them.

### Modified Capabilities
- `sidecar-protocol`: `POST /runs` body gains additive `disallowed_tools` / `connectors` / `skills`; the sidecar additionally exposes read-only, `cwd`-scoped connector + skill discovery that Rails proxies.
- `http-api-contract`: adds `GET /api/sessions/:id/connectors` and `GET /api/sessions/:id/skills`, and documents the additive run-start body fields (tools are a shared constant, not an endpoint).

## Impact

- **web/**: `skills_popover.tsx` (real discovered lists + toggles; tools from the shared constant), `prompt_composer.tsx` (send `disallowed_tools`/`connectors`/`skills`; real skills count), `run_banner.tsx` (echo), new `use_connectors`/`use_skills` hooks mirroring `use_models.ts` (no `use_tools` — tools are a constant), role-gating.
- **api/**: `RunsController#create` + a new run-scoping concern (validate against the shared tool constant + session discovery, fail-open when unavailable; the `:run` gate already denies reviewer/viewer); `Runs::Start` threads new kwargs into the sidecar payload + grows `DEFAULT_ALLOWED_TOOLS`; new session-scoped discovery controllers proxying the sidecar (cache key includes repo path, 502 on transport error); `Sidecar::Client#list_connectors(cwd:)`/`#list_skills(cwd:)`.
- **sidecar/**: new `cwd`-scoped discovery (parse `<cwd>/.mcp.json` + `~/.claude`, scan `SKILL.md` frontmatter) mirroring `models.ts`; `runner.ts buildOptions` maps the fields to `disallowedTools` / `mcpServers` (+ `mcp__x__*`) / `settingSources` + `skills`; `index.ts` discovery routes; `NormalizeContext` + `Normalizer.runStartedFromInit` echo the resolved capabilities. `transport.ts` unchanged.
- **contracts**: `packages/contracts` — the built-in tool constant, `RunStartedPayload` additive fields, shared connector/skill types, `CONTRACT_VERSION.minor` bump; `docs/contracts/sidecar_protocol.md` §5, `docs/contracts/http_api.md`, `docs/contracts/CHANGELOG.md`; `CLAUDE.md` run-start line.
- **Security**: connector/skill/tool configs are **host-owned and read-only**; the browser only selects among what the host configured — no arbitrary command/url/header ever crosses from the browser (mirrors the "auth is the host's, never app-owned" invariant). `disallowed_tools` is the real guardrail and remains effective even under `bypassPermissions` (deny rules always apply).
- **Out of scope (deferred):** per-tool live Bash approval / `canUseTool` wiring (stays allow-all), letting browser users *define* or edit MCP servers, interactive/OAuth connector auth, and creating/editing skills from the UI.
