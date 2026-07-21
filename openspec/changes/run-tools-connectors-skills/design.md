## Context

The composer surfaces three run-configuration controls — a Tools tab, a Connectors tab, and a "✦ Skills N" button — that are entirely mock (`web/src/components/session/skills_popover.tsx` carries a `⚠️ MOCK` banner; the "3" is a literal). Today the run-start pipeline (`web` → `RunsController#create` → `Runs::Start` → sidecar `POST /runs` → `buildOptions` → `query()`) carries only `model` and `permission_mode`. `Runs::Start` hardcodes `DEFAULT_ALLOWED_TOOLS = %w[Read Write Edit Bash]`; the sidecar maps `allowed_tools → allowedTools` with the same fallback. There is no `disallowed_tools`, no `mcpServers`, and no skills anywhere.

Verified Agent SDK mechanics this design depends on (from the `@anthropic-ai/claude-agent-sdk` docs):
- **`allowedTools` is a pre-approval list, not a restriction.** A tool omitted from it still runs (falls through to the permission mode / `canUseTool`, which is allow-all in this MVP). The **only** true disable is **`disallowedTools` with a bare tool name** (e.g. `"Bash"`), which removes the tool from context and applies **even under `bypassPermissions`** (deny rules always win).
- **`mcpServers`** is a `Record<string, config>` passed **per `query()`** (per run). Tools are namespaced `mcp__<server>__<tool>` and must be allowed via `mcp__<server>__*` (trailing `*` required). There is **no SDK API to enumerate configured servers** — they must be discovered by reading host config files.
- **Skills** load from the filesystem when `settingSources` includes `"user"`/`"project"`; `skills` is `"all" | string[] | []` and setting it auto-adds the `Skill` tool. There is **no programmatic list API** — skills are discovered by scanning `SKILL.md` files.

Constraints (CLAUDE.md invariants): the sidecar is the only SDK-aware code and the only code that touches host config; auth/config is the host's and read-only; the server enforces roles (the client only hides buttons); the Contract-1 event envelope + 20 type names are frozen (additive payload fields are cheap, new types are not); everything live is a Contract-1 event (no bespoke cable messages); `cwd` stays pinned to the worktree.

## Goals / Non-Goals

**Goals:**
- Make the Tools / Connectors / Skills surface real and **per-run**, wired end-to-end, with the same discover→select→validate→map→echo shape the `model` picker already uses.
- "Toggle a tool OFF" must **genuinely** stop Claude from using it that run (not merely un-pre-approve it).
- Discovery is **read-only** and reflects only what the **host** already configured; a browser user can enable/disable but never define capabilities.
- Server-side validation + role-gating; unknown/inert values rejected before reaching the sidecar.
- Everyone (incl. late joiners) can see what a finished/running run actually used, via an additive `run_started` echo — no new event type.

**Non-Goals:**
- Per-tool live approval / wiring `canUseTool` (stays allow-all — that is a separately security-reviewed phase).
- Letting browser users **define/edit** MCP servers, supply commands/URLs/headers, or perform interactive/OAuth connector auth.
- Creating/editing skills from the UI.
- Changing the event envelope or adding event types.

## Decisions

### D1 — OFF tools map to `disallowed_tools`, not to shrinking `allowed_tools`
The client sends `disallowed_tools` = the built-ins the user turned OFF. `Runs::Start` keeps `allowed_tools` = `DEFAULT_ALLOWED_TOOLS` (the pre-approval base) and passes `disallowed_tools` through; the sidecar sets `disallowedTools` from it. **Why:** verified SDK semantics — only bare `disallowedTools` truly removes a tool, and it holds even under `bypassPermissions`. **Alternative rejected:** sending a shrunken `allowed_tools` allow-list — it would not restrict anything while `canUseTool` is allow-all, making the toggle a lie. Modeling the payload as "the OFF set" also keeps the default (nothing disabled) identical to today's behavior and makes an empty/omitted field a safe no-op.

### D2 — Discovery is split: tools are a shared constant; connectors + skills are session-scoped sidecar discovery
The three sources are **not** alike, so they are not served alike:
- **Tools** are the 8 fixed built-ins — they never vary by host or repo. They live as a **shared constant in `packages/contracts`**, imported directly by `web` (the picker) and by Rails (the validation allowlist). There is **no `/api/tools` endpoint, no sidecar `listTools`, no `use_tools` hook** — routing a hardcoded list through sidecar→Rails→a cached query would be pure ceremony.
- **Connectors** (`.mcp.json`) and **skills** (`.claude/skills/*/SKILL.md`) are **per-repo project files**, and the repo is **per-session** (`Session#repository_path`; `Git::WorktreeManager` derives the repo dir from it). The sidecar is stateless — it has no "current repo" and only learns a path per request. So connector/skill discovery is **session-scoped**: `GET /api/sessions/:id/connectors` and `GET /api/sessions/:id/skills`; Rails resolves the session's `repository_path` and passes it to the sidecar (`GET /connectors?cwd=<path>`, `GET /skills?cwd=<path>`), which scans `<cwd>/.mcp.json` + `<cwd>/.claude/skills/*/SKILL.md` **plus host-wide `~/.claude`**. Proxied + cached like `GET /api/models`, but the **cache key includes the repo path**. Connectors expose `name` + `transport` only (never command/url/headers/env); skills expose `name` + `description` from frontmatter.

**Why session-scoped:** a flat, path-less endpoint (like `/api/models`) cannot know which repo, and would validate a run's selection against a *different* directory than the sidecar resolves at run time — the "drift" the reviewer flagged is a real bug, not an accepted trade-off. **The same repo path is used for both discovery and run-time resolution** (the session's `repository_path`, not the ephemeral worktree, since the worktree may not exist pre-run and untracked `.mcp.json` wouldn't be in a checkout). **Alternative rejected:** starting a throwaway `query()` to read the init message's MCP tools — slow, side-effectful, needs a run; filesystem parsing is synchronous and cheap.

### D3 — Connectors are host-owned; the browser selects names only
The run-start body's `connectors` is a list of **server names**. The sidecar resolves each selected name against the host-discovered config to build `mcpServers`, then appends `mcp__<name>__*` to `allowedTools`. Rails validates each requested name against the discovered set (unknown → 422). **Why:** stdio MCP servers execute arbitrary host commands; letting the browser pass a config would be remote code execution. This mirrors the existing invariant that Claude/AWS auth is the host's and app code never owns or selects a credential. **Trade-off:** a connector the host has not configured simply cannot be used from the UI — acceptable and safe.

### D4 — Skills are available to every run (no per-skill toggle); `settingSources` side effects are bounded
Skills are **not** individually selectable in the UI — matching Claude Code, where every installed skill is simply available and the model invokes them as needed. The Skills tab is a **read-only list** of what the host has; the composer sends `skills: "all"` when the host has any (and omits it when there are none, preserving today's behavior). The badge shows the **discovered** count. (The wire format still accepts an explicit name array — the contract is unchanged — the UI just doesn't expose per-skill selection.) When `skills` is sent the sidecar sets `settingSources:["user","project"]` + `skills`, which auto-adds the `Skill` tool.

> Earlier this was a per-skill opt-in defaulting OFF; changed per product direction — a granular skill toggle is noise, skills should just be available.

**Critical side effect (must be bounded):** today `buildOptions` passes **no** `settingSources`, so nothing from `~/.claude/settings.json` or the repo's `.claude/settings.json` loads. Setting `settingSources` to enable skills *also* loads those files' hooks, permissions, subagents, slash commands, env, and any `mcpServers` they declare. This is acceptable **because those settings are host-owned** — the same `~/.claude` + repo the host already trusts (consistent with the "auth/config is the host's" invariant); a browser user toggling skills ON is opting the run into the host's own project/user config, never into anything the browser supplied. To keep it bounded: the sidecar's **explicitly-built `query()` options win** — the `mcpServers` (from selected connectors), `disallowedTools`, and `allowedTools` it constructs take precedence over anything a settings file declares, and a test asserts a settings-file `mcpServers`/hook does not override or silently expand the explicit set. **Alternative considered:** default `"all"` — rejected; silently enabling every skill (and loading all settings) changes behavior/context without consent.

### D5 — Reuse `run_started` (additive payload), no new event type — echo the RESOLVED capabilities
`RunStartedPayload` gains optional `disallowed_tools? / connectors? / skills?` (and `CONTRACT_VERSION.minor` bumps). **Wiring (the reviewer's F3 gap):** `run_started` is produced by `Normalizer.runStartedFromInit`, which today reads only the SDK init message and has no access to the selection. So: (a) `NormalizeContext` gains the applied capabilities; (b) `Runner.startRun` passes the **resolved** values (the connectors actually resolved, skills actually enabled — not the raw request) into the `Normalizer`; (c) `runStartedFromInit` adds them to the payload. `web/src/stores/event_store.ts` + `run_banner.tsx` read `run_started.payload` via loose casts, so additive fields don't break typing. `fake_claude/replay.rb` does not synthesize `run_started`, so no Rails-side echo path is needed. **Why:** the envelope + type names are frozen; additive payload fields are the sanctioned cheap change and give gap-free late-joiner catch-up for free (run_started is durable + backfilled). No DB column.

### D6 — Validation + role-gating in a `RunsController` concern, mirroring `run_permission_modes.rb`
A concern validates `disallowed_tools` ⊆ the shared built-in tool constant (D2), `connectors` ⊆ the session's discovered names, `skills` ⊆ discovered names (or `"all"`); rejects unknowns with 422. The whole surface is **already** behind the `:run` policy action — `RunsController#create` calls `authorize_action!(:run, session)`, so reviewer/viewer already get 403; no new gating code is needed, only the new validation. `bypassPermissions` stays owner-only (unchanged). **Fail-open when discovery is unavailable:** if the sidecar reports the connector/skill source unavailable (empty), Rails SHALL NOT 422 a selection — it passes the names through and the sidecar (which resolves defensively, ignoring unknown names) is the backstop. This avoids a spurious rejection when discovery is transiently empty. **Why:** consistency with `session-run-modes`; the client only hides controls, the server is the gate.

### D7 — Discovery proxy matches `ModelsController` exactly, including failure
The session-scoped proxy controllers mirror `ModelsController`: gate on **participantship** (nested under the session → `SessionPolicy` view gate; cross-session → `404`), and on a `Sidecar::Client` `TransportError` (sidecar down) respond **`502`** — the same behavior `models_spec.rb` pins — **not** an empty list. An empty list is returned only when the sidecar itself reports the source unavailable. `Sidecar::Client` gains `list_connectors(cwd:)` / `list_skills(cwd:)` mirroring `list_models`, covered in `client_spec.rb`. **Why:** one discovery pattern, no bespoke divergence; the fail-open validation (D6) already handles the transient-empty case without needing discovery to lie about being reachable.

### D9 — UI has no per-item toggles: every capability is available to the run
Per product direction, the popover is a **read-only display** of what the host has — no per-tool/connector/skill switches. Every run gets **all built-in tools** (no `disallowed_tools` from the UI), **all host-configured connectors** (the composer sends the full discovered name list), and **all skills** (`skills: "all"`) — matching how Claude Code normally makes everything available and letting the model choose. The wire contract is unchanged (`disallowed_tools`/`connectors`/`skills` still exist and Rails still validates them); the UI simply always enables everything, and omits a field when the host has none of that kind (preserving today's behavior). **Host connector reads:** `~/.claude.json` is atomically rewritten by Claude Code, which breaks a live single-file bind mount, so the sidecar entrypoint snapshots it once at startup to a stable path discovery reads (refreshed per restart; MCP lists change rarely).

### D8 — Pre-approval base grows to match the advertised tool set
`Runs::Start::DEFAULT_ALLOWED_TOOLS` today is `Read/Write/Edit/Bash` but the picker advertises 8 tools ON. Add `Glob/Grep/WebSearch/WebFetch` to the pre-approval base so every advertised-ON tool is genuinely pre-approved. **Why:** today it only "works" because `canUseTool` is allow-all; when per-tool gating lands (the deferred phase), an advertised-ON tool missing from the base would become a silent no-op. Aligning the base now removes that latent trap.

## Risks / Trade-offs

- **[MCP config formats vary / `.mcp.json` may be absent]** → Discovery is defensive: missing/unparseable config yields an empty connector list (never a crash), exactly as `useModels` returns `[]` on an unavailable source; the UI then shows no connectors rather than fake ones.
- **[Discovery vs run-time drift]** → Resolved by D2: discovery and run-time resolution use the **same** session `repository_path`, and validation fails open when discovery is unavailable (D6), so a valid selection is never spuriously rejected. The `run_started` echo reflects what was actually applied, not what was requested.
- **[`settingSources` loads more than skills]** → Bounded per D4: the settings loaded are host-owned; explicit `query()` options win; a leakage test guards against settings-file `mcpServers`/hooks silently expanding a run.
- **[Non-blocking MCP connect: a selected server may fail to come up mid-run]** → Out of scope to surface live connector health this phase; the run proceeds with whatever connected (SDK default), and the tool simply isn't available. Documented as a known limitation; live connector status is deferred.
- **[Enabling many skills inflates context]** → Skills default-OFF (D4); the count/list is shown so users opt in deliberately.
- **[Contract drift across three streams]** → `packages/contracts` shared types are the executable seam; `docs/contracts/*` + a `CHANGELOG.md` entry document the additive change; the taxonomy/envelope is untouched so the freeze rules classify this as a cheap additive change, not an emergency.
- **[`bypassPermissions` ignores `allowed_tools`]** → Intended and safe here: `disallowed_tools` (deny) still applies under bypass, so an OFF tool stays off even in bypass mode.

## Migration Plan

Additive and backward-compatible — no data migration. Older clients that omit the new fields get today's behavior (nothing disabled, no connectors, no skills). Deploy order is irrelevant because each field is optional at every hop; if the sidecar ships before the web wiring, the fields are simply absent. Rollback = revert the change; no persisted state depends on it (the echo lives only in event payloads).

## Open Questions

- Exact host connector-config precedence (session repo `<cwd>/.mcp.json` vs `~/.claude`/`~/.claude.json`) and de-dup by name — resolved during implementation by inspecting the host's actual files; the contract only promises "name + transport from host-configured servers," so precedence is an implementation detail, not a contract commitment.
- Whether to show a live per-connector connected/failed indicator — deferred (see Risks); this phase surfaces the configured set only.
