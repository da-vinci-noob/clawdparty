## Context

`Runs::Start` posts `permission_mode: 'acceptEdits'` and a fixed `allowed_tools` whitelist to the sidecar; `sidecar/src/runner.ts#buildOptions` already reads `input.permission_mode ?? "acceptEdits"`, so the wire + SDK plumbing accept any mode — the value is pinned only in the Rails layer and frozen at `acceptEdits` in `sidecar-protocol`. The Agent SDK supports `plan | acceptEdits | bypassPermissions | default | dontAsk` and can switch mid-run via `query.setPermissionMode`. This change exposes a safe subset and adds the mid-run switch, staying within the "no shell input path" invariant. It builds on the current run-control flow (`run-control-api`) and the four-role `SessionPolicy`.

## Goals / Non-Goals

**Goals:**
- Let run-capable users pick `plan` / `acceptEdits` / `bypassPermissions` at run start, defaulting to today's `acceptEdits`.
- A Plan → review → Execute flow that reuses changeset review for the edits.
- Keep it contract-additive (no new event types, no migration) and keep every mode's `cwd` pinned to the worktree.

**Non-Goals:**
- **Ask-per-tool / `default` mode** — deferred (needs `canUseTool` wired in + a live approval transport + multi-user "who approves"). Changeset review is the current substitute.
- **Raw OS shell / PTY** — deferred to a security-reviewed phase; would reverse the no-shell invariant.
- Per-mode `allowed_tools` customization by the user; the whitelist stays server-set.

## Decisions

- **Allowlist, not passthrough.** Rails validates `permission_mode` against `%w[plan acceptEdits bypassPermissions]` and `422`s anything else — even though the sidecar would technically accept `default`/`dontAsk`. This keeps unsupported/unsafe modes out until their own phase, and means the client can't smuggle in `default` (which would silently *deny* tools headlessly).
- **`bypassPermissions` is owner-only.** Per the SDK, bypass ignores `allowed_tools`, so Claude could invoke tools outside the `Read/Write/Edit/Bash` whitelist — a real guardrail removal. Gate it behind a new owner-only policy check; `plan`/`acceptEdits` are allowed for `owner`+`editor` (the existing run gate). Alternative — allow bypass for editors too — rejected on least-privilege grounds.
- **Mid-run switch for plan→execute, with a fallback.** Preferred path: `POST /runs/:id/permission_mode` → `runner.setPermissionMode(runId, 'acceptEdits')` → `query.setPermissionMode`, so the plan's context/session carries straight into execution (no re-exploration). Fallback if the run has already ended: a fresh `acceptEdits` follow-up/revise run resuming the same `claude_session_id`. The endpoint is role-gated identically to run control.
- **Mode surfaced via the existing `run_started` payload.** It already carries `permission_mode` (and `model`/`cwd`), so the banner reads it from the event stream — no `ai_runs` column, no migration, no new event type.
- **Plan-ready detection = run completion.** Plan mode has no `ExitPlanMode` tool; a plan run simply finishes (`run_finished`) having only produced text (no changeset, since no edits). The UI shows "Execute plan" when a `plan`-mode run finishes; it does not try to parse a structured plan object.
- **Contract change is a MODIFIED requirement, logged.** `sidecar-protocol` §"Permission mode and tool scoping" flips from "every run starts with `acceptEdits`" to "defaults to `acceptEdits`, selectable from the allowlist"; the run-control endpoints requirement gains `POST /runs/:id/permission_mode`. Per the freeze rules this needs a `CHANGELOG.md` entry (done in tasks). It is not an envelope/event change.

## Risks / Trade-offs

- **[`bypassPermissions` lets Claude exceed the tool whitelist]** → Owner-only; `cwd` still pinned to the worktree; document it as a power-user mode in the UI (a visible warning) and in the contract. Not the default, never editor-accessible.
- **[Mid-run `setPermissionMode` races a finishing run]** → If the run has already reached a terminal state, the endpoint returns a clear error and the client falls back to a fresh `acceptEdits` run resuming the session. The switch is only offered while/just-after the plan run is active.
- **[A `plan` run that still emits edits]** → In plan mode the SDK routes edits to `canUseTool` and never auto-approves; with the allow-all `canUseTool` currently *not wired into `query()`*, plan mode's own "no auto-approve edits" behavior governs. Verify during apply that a plan run produces no changeset; if the dormant `canUseTool` would auto-allow, wire a plan-aware guard (deny edits) as part of this change.
- **[Client hides the control but server must enforce]** → Role/allowlist checks live in `RunsController`/`SessionPolicy`; the composer control is presentation only (bypass hidden for non-owners, whole control hidden for reviewer/viewer). Request specs assert server-side rejection independent of the UI.
- **[Contract drift]** → One MODIFIED requirement in `sidecar-protocol` + a CHANGELOG entry; the `docs/contracts/*.md` prose and CLAUDE.md line are updated in the same change to avoid the spec and docs disagreeing.
