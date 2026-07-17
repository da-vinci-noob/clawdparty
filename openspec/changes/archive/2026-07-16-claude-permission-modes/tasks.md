## 1. Backend — run-start mode selection + role gating

- [x] 1.1 Add a `PERMISSION_MODES = %w[plan acceptEdits bypassPermissions].freeze` allowlist (constant shared by controller + `Runs::Start`); default `acceptEdits`.
- [x] 1.2 `Runs::Start#initialize` accepts `permission_mode:` (default `acceptEdits`); stop hardcoding it in the payload — send the passed value. Keep `allowed_tools` server-set.
- [x] 1.3 `RunsController#create` reads `params[:permission_mode]`, validates against the allowlist → `422 { errors: [...] }` on a bad value (no run started).
- [x] 1.4 Role gating: `SessionPolicy` (or the controller) restricts `bypassPermissions` to `owner`; `plan`/`acceptEdits` allowed for owner+editor; reviewer/viewer already blocked from running. Non-owner bypass → `403`, no run.

## 2. Backend — mid-run permission switch (plan → execute)

- [x] 2.1 Add a role-gated Rails member route `POST /api/runs/:id/permission_mode` → controller action that validates mode (allowlist + bypass owner-only) and forwards via `Sidecar::Client` to the sidecar `POST /runs/:id/permission_mode`.
- [x] 2.2 `Sidecar::Client` gains a `set_permission_mode(run_id, permission_mode, requested_by)` method mapping to the sidecar endpoint; handle `404` (unknown) / `409` (not active) so the caller can fall back.

## 3. Sidecar — permission_mode passthrough + switch endpoint

- [x] 3.1 Confirm `runner.ts#buildOptions` forwards `permission_mode` to `query()` (already does); ensure the allowlisted values flow through unchanged.
- [x] 3.2 `runner.ts`: add `setPermissionMode(runId, mode)` calling the SDK query handle's `setPermissionMode`; raise `UnknownRun` if absent and a distinct "not active" error if the run is terminal.
- [x] 3.3 `index.ts`: add `POST /runs/:id/permission_mode` → `runner.setPermissionMode`; return `200 { run_id, permission_mode }`, `404` unknown, `409` not active (per the amended sidecar-protocol).

## 4. Frontend — mode control, banner, execute-plan

- [x] 4.1 `prompt_composer.tsx`: a mode control (Plan / Auto-accept / Bypass) sending `permission_mode` on run start; render only for run-capable roles; Bypass option shown to owners only (`can(...)`-gated). A short warning tooltip on Bypass.
- [x] 4.2 `feed/run_banner.tsx`: show the active mode from the `run_started` payload (`permission_mode`).
- [x] 4.3 "Execute plan" affordance: when a `plan` run finishes, offer a run-capable action that calls `POST /api/runs/:id/permission_mode` → `acceptEdits`; on `409`/not-active, fall back to a fresh `acceptEdits` follow-up/revise run resuming the session.

## 5. Contract + docs

- [x] 5.1 Amend `docs/contracts/sidecar_protocol.md` §5 (permission_mode now an allowlist, default `acceptEdits`) + the run-control endpoints list (`POST /runs/:id/permission_mode` with its `200`/`404`/`409` shapes).
- [x] 5.2 Add a `docs/contracts/CHANGELOG.md` entry (contract change, not envelope; per the freeze rules).
- [x] 5.3 Update the CLAUDE.md line "Run start carries `permission_mode: acceptEdits`" → "defaults to `acceptEdits`; selectable among `plan`|`acceptEdits`|`bypassPermissions` (bypass owner-only)".

## 6. Tests + verification

- [x] 6.1 api: `Runs::Start` spec — mode threaded to payload; default `acceptEdits` when omitted; unknown mode rejected before posting.
- [x] 6.2 api: `runs_controller` request spec — `422` on bad mode; role matrix (editor may plan/acceptEdits; editor bypass → `403`; owner bypass ok; reviewer/viewer → `403`); the `POST /runs/:id/permission_mode` endpoint role-gated + validated.
- [x] 6.3 sidecar: runner/index tests — `permission_mode` passed to `query()`; `POST /runs/:id/permission_mode` calls `setPermissionMode` and returns the pinned shapes (`200`/`404`/`409`).
- [x] 6.4 web: `prompt_composer` tests — selected mode sent; control hidden for non-run roles; Bypass owner-only; `run_banner` shows the mode; plan→Execute triggers the switch (with fallback).
- [x] 6.5 Full suites green (api RSpec + RuboCop, web Vitest + Biome + tsc, sidecar Vitest + tsc); `openspec validate claude-permission-modes` passes; manual smoke: start a Plan run (no edits) → Execute → edits appear → changeset review.
