## 1. Contracts & shared types (do first — the seam all streams build against)

- [x] 1.1 `packages/contracts`: add the canonical built-in **tool constant** (`BUILTIN_TOOLS: ToolInfo[]` with `Read/Write/Edit/Bash/Glob/Grep/WebSearch/WebFetch`, each `{id,label,description}`), exported for web + Rails.
- [x] 1.2 `packages/contracts/src/events.ts`: extend `RunStartedPayload` with additive optional `disallowed_tools?: string[]`, `connectors?: string[]`, `skills?: string[]`; add shared `ConnectorInfo {name,transport}` + `SkillInfo {name,description}` types; bump `CONTRACT_VERSION.minor` (1.3 → 1.4). The 22-name event-type guard is untouched (no new type).
- [x] 1.3 `docs/contracts/sidecar_protocol.md` §5: document the additive `disallowed_tools`/`connectors`/`skills` on `POST /runs` and the `cwd`-scoped sidecar discovery (`GET /connectors?cwd=`, `GET /skills?cwd=`; name+transport only).
- [x] 1.4 `docs/contracts/http_api.md`: document `GET /api/sessions/:id/connectors|skills` (success `{…, source}`; empty+unavailable vs `502`; cross-session `404`) and the additive run-start body fields (`422` on unknown, existing `:run` `403` gate). Note tools are a shared constant, not an endpoint.
- [x] 1.5 `docs/contracts/CHANGELOG.md`: add an entry (additive, documented contract change — not an envelope change).
- [x] 1.6 `CLAUDE.md`: update the run-start line to mention selectable tool/connector/skill scoping (default = nothing disabled / no connectors / no skills).

## 2. Sidecar (the only SDK-aware / host-config-reading stream)

- [x] 2.1 New `sidecar/src/capabilities.ts` (mirroring `models.ts`): `listConnectors(cwd)` parses `<cwd>/.mcp.json` + `~/.claude`/`~/.claude.json` `mcpServers` → `{name,transport}` (empty+unavailable on missing/unparseable, never throw); `listSkills(cwd)` scans `<cwd>/.claude/skills/*/SKILL.md` + `~/.claude/skills/*/SKILL.md`, parses frontmatter → `{name,description}`. Never surface command/url/headers/env.
- [x] 2.2 `sidecar/src/capabilities.ts`: `resolveConnectors(cwd, names)` → `{ mcpServers, allowedToolPatterns }` resolving requested names against host config into SDK `mcpServers` entries + `mcp__<name>__*` patterns; ignore unknown names defensively.
- [x] 2.3 `sidecar/src/index.ts`: add read-only routes `GET /connectors` + `GET /skills` (read `cwd` from query) returning the pinned shapes.
- [x] 2.4 `sidecar/src/runner.ts`: extend `StartRunInput` with `disallowed_tools`/`connectors`/`skills`; in `buildOptions` set `disallowedTools` from OFF tools (bare names); merge resolved connector `mcpServers` + append `mcp__<name>__*` to `allowedTools`; when `skills` non-empty/`"all"` set `settingSources:["user","project"]` + `skills`; keep `cwd` pinned. Ensure the explicitly-built `mcpServers`/`disallowedTools`/`allowedTools` take precedence over anything settings files would inject.
- [x] 2.5 `sidecar/src/normalizer.ts`: extend `NormalizeContext` with the applied capabilities; in `Runner.startRun` pass the **resolved** `disallowed_tools`/`connectors`/`skills` (what actually applied) into the `Normalizer`; add them to the `runStartedFromInit` payload. (`fake_claude/replay.rb` doesn't synthesize `run_started`, so no Rails echo path.)
- [x] 2.6 Sidecar tests (Vitest): discovery (fixture `.mcp.json` → names+transport only; fixture `SKILL.md` → name+description; missing config → empty+unavailable); `buildOptions` (OFF tool → `disallowedTools`; connector → `mcpServers`+`mcp__x__*`; skills → `settingSources`+`skills`; omitted → today's behavior); a **leakage test** asserting a settings-file `mcpServers`/hook does not override/expand the explicit option set; `runStartedFromInit` echoes the resolved capabilities. Biome + `tsc` clean.

## 3. Rails (validation, proxy — role gate already exists)

- [x] 3.1 `Sidecar::Client`: add `list_connectors(cwd:)` + `list_skills(cwd:)` mirroring `list_models` (return `Result`, `.body`); cover in `client_spec.rb`.
- [x] 3.2 Session-scoped discovery controllers proxying the sidecar (cache key includes the session's `repository_path`; `502` on `TransportError`, matching `ModelsController`): `GET /api/sessions/:id/connectors`, `GET /api/sessions/:id/skills`; gate on participantship (nested under the session; cross-session `404`). Add routes.
- [x] 3.3 New `RunsController` concern (mirroring `run_permission_modes.rb`): read + validate `disallowed_tools` ⊆ the shared built-in tool constant, `connectors` ⊆ session-discovered names, `skills` = `"all"` or ⊆ discovered names; unknown → `422 { errors }`. **Fail-open** when the connector/skill source is unavailable (don't 422 — let the sidecar be the backstop). No new gating — `#create` already calls `authorize_action!(:run, session)`; `bypassPermissions` stays owner-only.
- [x] 3.4 `Runs::Start`: grow `DEFAULT_ALLOWED_TOOLS` to the 8 advertised built-ins; add `disallowed_tools:`/`connectors:`/`skills:` kwargs (defaulting to none); thread into the `post_to_sidecar` payload. Update `RunsController#create` to pass them from the concern.
- [x] 3.5 API tests (RSpec): `Runs::Start` spec (fields threaded to payload; defaults when omitted; grown allow base); `runs_controller` request spec (valid selection → 202; unknown value → 422; fail-open when discovery empty; reviewer/viewer → 403; bypass owner-only unchanged); discovery controller specs (proxy shape; cross-session 404; `502` when sidecar down; empty when source unavailable). RuboCop clean.

## 4. Web (real UI, wired to run start)

- [x] 4.1 New hooks `use_connectors.ts` + `use_skills.ts` mirroring `use_models.ts` (TanStack Query keyed by session id; only real discovered entries, `[]` when unavailable — no fake fallbacks). Tools come from the shared `BUILTIN_TOOLS` constant (no hook).
- [x] 4.2 Rewrite `web/src/components/session/skills_popover.tsx`: render Tools from `BUILTIN_TOOLS` (default ON; toggle OFF), Connectors (default OFF; toggle ON), Skills (default OFF; toggle ON) from the hooks; lift selection state to the composer (props/callback) instead of throwaway local state; remove the MOCK banner.
- [x] 4.3 `web/src/components/prompt_composer.tsx`: hold the capability selection; send `disallowed_tools` (OFF tools), `connectors` (ON names), `skills` (ON names or `"all"`) in the run-start POST; make the "✦ Skills" badge the real discovered count; role-gate the control (hidden for reviewer/viewer).
- [x] 4.4 `web/src/components/feed/run_banner.tsx`: show the echoed `disallowed_tools`/`connectors`/`skills` from `run_started` when present.
- [x] 4.5 Web tests (Vitest + RTL + MSW): discovered lists render; toggling sends the correct `disallowed_tools`/`connectors`/`skills` on run start; real skills count; control hidden for non-run roles; run_banner echo. Biome + `tsc` clean.

## 5. Review & verify

- [x] 5.1 `openspec validate run-tools-connectors-skills --type change --strict` clean.
- [x] 5.2 Run all three suites + linters green (api: RSpec + RuboCop; sidecar: Vitest + Biome + tsc; web: Vitest + Biome + tsc).
- [ ] 5.3 Commit (signed) on a branch, open a PR, confirm CI green, and (on approval) admin-merge + sync main.
