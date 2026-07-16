## Why

Every run is pinned to Claude's `acceptEdits` permission mode — Claude edits freely and everything lands behind changeset review. Users have no way to say "just plan this first, don't touch files" or otherwise pick how much latitude Claude has, which is the everyday `Shift+Tab` gesture in the Claude Code CLI. Exposing a **Plan mode** in particular is high-value: explore + propose without edits, review, then execute. The plumbing is already present (the sidecar runner accepts `permission_mode`); only Rails pins the value. This is Phase 1 of "let users change Claude's mode" and stays fully within the "no shell input path / terminal is read-only" invariant.

## What Changes

- **Selectable permission mode at run start** — the run-start request MAY carry `permission_mode`, validated server-side against an allowlist: `plan` | `acceptEdits` (default, current behavior) | `bypassPermissions`. Omitted → `acceptEdits`. Unknown/unsupported (incl. `default`/`dontAsk`/ask-per-tool) → `422`.
- **Role gating** — only run-capable roles (`owner`/`editor`) may pick a mode (same gate as starting a run). **`bypassPermissions` is owner-only**, because per the Agent SDK it *ignores* the `allowed_tools` whitelist (Claude may use tools beyond `Read/Write/Edit/Bash`) — it removes a guardrail. `cwd` stays pinned to the session worktree in all modes.
- **Plan → Execute flow** — a `plan` run explores read-only and produces a plan with no edits; when it finishes, the UI offers **"Execute plan"**, which continues in `acceptEdits` via a new sidecar endpoint `POST /runs/:id/permission_mode` (`query.setPermissionMode`), falling back to a fresh `acceptEdits` follow-up run. Resulting edits ride the existing changeset review unchanged.
- **UI** — a CLI-style mode control in the prompt composer (Plan / Auto-accept / Bypass), the active mode surfaced in the run banner (the `run_started` payload already carries `permission_mode`), and the Execute-plan affordance.
- **Contract + docs** — amend `docs/contracts/sidecar_protocol.md` §5 + `CHANGELOG.md`; update the CLAUDE.md "Run start carries `permission_mode: acceptEdits`" line to "defaults to `acceptEdits`; selectable among `plan`|`acceptEdits`|`bypassPermissions`".
- **No new event types, no migration, no DB column** (mode is per-run and already in the `run_started` payload).

## Capabilities

### New Capabilities
- `claude-permission-modes`: the Rails-side selection surface — allowlist validation, role gating (bypass owner-only), default-to-`acceptEdits`, the Rails run-control endpoint that switches mode mid-run (plan→execute), and the client mode control + Execute-plan affordance. Consumes `run-control-api` (run-start + Sidecar::Client) and `invite-auth`'s `SessionPolicy` role matrix by name.

### Modified Capabilities
- `sidecar-protocol`: the Rails→sidecar wire contract changes — `permission_mode` on `POST /runs` becomes a selectable allowlist value (default `acceptEdits`) rather than the fixed literal, and a new additive route `POST /runs/:id/permission_mode` is added. The `canUseTool` allow-all seam and worktree-pinned `cwd` are unchanged.

## Impact

- **api/** — `RunsController#create` reads + validates `permission_mode`; `Runs::Start#initialize` accepts `permission_mode:` and stops hardcoding it in the payload; `SessionPolicy` gates bypass to owner. New `RunsController` member route (e.g. `POST /api/runs/:id/permission_mode`) forwarding through `Sidecar::Client` to the sidecar. No migration.
- **sidecar/** — `index.ts` gains `POST /runs/:id/permission_mode` calling `runner`'s handle `setPermissionMode`; `runner.ts` exposes a `setPermissionMode(runId, mode)` that calls the SDK query handle. `buildOptions` already honors `permission_mode`.
- **web/** — `prompt_composer.tsx` mode control (role-gated; bypass owner-only) sending `permission_mode`; `feed/run_banner.tsx` shows the mode; a Plan-ready "Execute plan" action.
- **Contracts** — `docs/contracts/sidecar_protocol.md` §5 + `CHANGELOG.md`; contract change (not envelope), Contract-1 event taxonomy unchanged.
- **Out of scope (future phases, each its own change + plan amendment + security review):** ask-per-tool / `default` mode (needs `canUseTool` wired in + a live per-tool approval transport + multi-user "who approves" semantics), and the raw OS shell / PTY (reverses the no-shell-input invariant).
