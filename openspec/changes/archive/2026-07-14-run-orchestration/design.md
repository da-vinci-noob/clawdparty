## Context

This is the Rails run-orchestration half of Week 2 and the A↔B integration seam. W1 left the pieces it builds
on: the `ai_runs` nine-state enum (native PG, values only — no transitions), the one-active-run partial unique
index (`WHERE status IN ('queued','running','awaiting_review')`), `Events::Append` (mutation + event in one
transaction, broadcast in-service), `SessionPolicy` (the 4-role matrix, run/interrupt = owner+editor), and
`ai_runs.requested_by`/`claude_session_id`/`base_sha` columns (nullable, provisioned for exactly this work).
The frozen `sidecar-protocol` pins the wire: `POST /runs` carries `run_id`, `session_id`, `repo_path` (the
worktree), `prompt`, `requested_by`, optional `claude_session_id`/`model`, `permission_mode: acceptEdits`, an
`allowed_tools` whitelist; returns `202 { run_id, status: "running" }` or `409` if a run is active. The worktree
convention is frozen too: **Rails creates** `<repo>/.clawdparty/worktrees/session-<id>` on `clawd/session-<id>`;
the sidecar only uses it as `cwd`; `base_sha` recorded at run start; identical container path so the absolute
gitdir resolves in both (`dev-docker-compose` mounts `/repo` in both and sets git `safe.directory`).

The subtle correctness rule carried forward from `rails-foundation` design Decision 13: **reject severs
`claude_session_id` chaining**. After a reject (`git reset --hard HEAD && git clean -fd`), the next run must NOT
resume the old Claude session — its context believes the reverted edits still exist. Only **revise** resumes
(old run → `superseded`, dirty tree kept, cumulative diff reviewed as one changeset). This change encodes the
data side of that rule in `Runs::Start`.

This change is spike-independent: it orchestrates lifecycle/worktrees/HTTP and treats run events' payloads as
opaque on ingest.

## Goals / Non-Goals

**Goals:**
- `Git::WorktreeManager`: create the frozen-path worktree, record `base_sha`, reset/teardown — operating on
  `/repo` so the worktree resolves in the sidecar container too.
- `Runs::Start`: one-active-run enforcement (DB index is the backstop; service checks + handles the race),
  clean-worktree requirement (except revise), worktree+`base_sha`, create the `queued` run, POST to the sidecar
  — NOT emitting `run_started` (the sidecar emits it; Rails transitions `queued → running` on ingest); encode
  reject-no-resume / revise-resumes via `claude_session_id`.
- `Runs::Finalize`: drive terminal transitions from ingested run-lifecycle events, not polling.
- The three run-control endpoints, `SessionPolicy`-gated, forwarding via `Sidecar::Client` over `SIDECAR_URL`.
- Request/service specs: role matrix, one-active-run `409`, worktree convention, reject-no-resume.

**Non-Goals:**
- The sidecar runner (`query()` loop, normalizer) — `sidecar-runner`.
- The changeset approve=commit / reject=revert service and its git edge-case units — W3 (this change only
  encodes the *data* rule that reject must sever chaining; the revert itself is W3).
- Diff/file APIs — `file-and-diff-api`.
- Any UI (prompt composer / interrupt button) — `prompt-composer-chat`.
- Sidecar-restart resume orchestration / heartbeat stale-run reconciliation (`Sidecar::HealthcheckJob`) — W2/W3
  sidecar supervision, not this change.

## Decisions

**1. The DB partial index is the one-active-run source of truth; `Runs::Start` handles the race, doesn't replace
it.** `Runs::Start` checks for an active run and, on the create, relies on the partial unique index to reject a
concurrent second start with `ActiveRecord::RecordNotUnique`, translated to a `409`. *Why:* a Ruby-only check
races under concurrent starts; the index is what actually prevents two active runs (W1 Decision 2). The service
gives a clean error path; the DB gives the guarantee.

**2. Rails creates the worktree via `git worktree add`; the sidecar never creates or relocates it.** On a
non-revise start with a clean tree, `Git::WorktreeManager` runs `git worktree add <repo>/.clawdparty/worktrees/
session-<id> -b clawd/session-<id>` (or reuses an existing one for the session), and records `base_sha = git
rev-parse HEAD` of that worktree at start. *Why:* frozen `sidecar-protocol` worktree convention; git worktrees
record absolute gitdir paths, so creation must happen at the `/repo` path both containers share. *Cross-uid:*
root-rails creates it; node-sidecar runs git in it — the `safe.directory` for `/repo` + `/repo/.clawdparty/
worktrees/*` (set in the sidecar image by `dev-docker-compose`) is what stops "dubious ownership." This change
asserts the created worktree resolves; it does not re-solve ownership (already solved).

**3. Run start is asynchronous from the client's view; status comes from events.** `POST /api/sessions/:id/runs`
creates the run (`queued`) and calls the sidecar `/runs` (which returns `202`), then responds to the client
without waiting for completion. The sidecar emits `run_started`; Rails ingests it and advances `queued → running`,
then to terminal, via `Runs::Finalize`
reacting to ingested lifecycle events. *Why:* mirrors the frozen `sidecar-protocol` (`202`, events arrive via
the callback) and the invariant that the event stream alone reconstructs the UI — no bespoke run-status cable
message.

**4. `Runs::Finalize` is event-driven, invoked from the ingest path, not a poller.** When a run-lifecycle event
is ingested (`run_finished`/`run_failed`/`run_interrupted`/`changeset_ready`), Rails transitions the run:
`run_finished` → `completed_clean` (clean tree) or `awaiting_review` (changeset ready); `run_failed` → `failed`;
`run_interrupted` → `awaiting_review` if the worktree is dirty, else `completed_clean`. *Why:* the sidecar
emits lifecycle as events (it does NOT finalize run state — `sidecar-runtime` spec); Rails owns the transition.
*Boundary:* the exact dirty-vs-clean finalize uses `git status` on the worktree, the same mechanism the diff API
will use; this change finalizes status, the changeset service (W3) does the commit/revert.

**5. Reject severs `claude_session_id`; only revise passes it to `/runs`.** `Runs::Start` accepts a `mode`
(default `fresh`, or `revise`). On `revise`, it supersedes the prior run (→ `superseded`), keeps the dirty tree,
and passes the prior `claude_session_id` to the sidecar so Claude resumes. On a `fresh` start after a reject, it
does NOT pass `claude_session_id` — the next run begins a new Claude session, because the reverted worktree no
longer matches the old session's context. *Why:* `rails-foundation` Decision 13 + `docs/PLAN.md §8`; resuming a
session whose context believes reverted edits exist is the subtle correctness bug this rule prevents. *Scope:*
the revert itself (`git reset --hard && git clean -fd`) is W3's changeset service; this change encodes only that
a post-reject start must not carry `claude_session_id`, and that revise must.

**6. `Sidecar::Client` is the only Rails→sidecar caller, configured by `SIDECAR_URL`.** A thin HTTP client wraps
the three Rails→sidecar calls, targets `SIDECAR_URL` (default `http://sidecar:8787`, no hard-coded host), and
maps the frozen responses (`202`/`200`/`409`/`404`). *Why:* one place owns the seam; `SIDECAR_URL`
configurability keeps Tailscale a drop-in. *Test seam:* the client is injectable so request specs stub it
(no running sidecar needed); a focused client spec asserts the wire shape.

**7. Until `sidecar-runner` lands, the seam is exercised against a double.** `Runs::Start` request specs stub
`Sidecar::Client` to assert the correct `/runs` payload (incl. `requested_by`, `permission_mode`,
`allowed_tools`, `repo_path` = the worktree); `Runs::Finalize` specs feed lifecycle events through `Events::Ingest`
(the fake-Claude path) and assert transitions. *Why:* `docs/PLAN.md §11` stub strategy — nobody waits for the
other stream; the contract is the seam.

## Risks / Trade-offs

- **Cross-uid worktree git failure at runtime (root creates, node runs git).** The exact hazard W1 hit.
  *Mitigation:* `safe.directory` is already configured (`dev-docker-compose`); this change adds an integration
  check that a Rails-created worktree resolves when git runs in it as the sidecar user, so a regression surfaces.
- **One-active-run race under concurrent starts.** *Mitigation:* rely on the partial unique index + rescue
  `RecordNotUnique` → `409`; a spec starts two runs concurrently and asserts exactly one wins.
- **Reject-then-resume correctness (the subtle one).** Passing `claude_session_id` after a reject would resume a
  session out of sync with the reverted tree. *Mitigation:* `Runs::Start` only passes `claude_session_id` on
  `revise`; a spec asserts a `fresh` start after a reject sends no `claude_session_id`, while `revise` does.
- **Finalize driven by events that don't exist until the runner lands.** *Mitigation:* `Runs::Finalize` is
  exercised by injecting lifecycle events through ingest now; it does not depend on a live runner to be tested.
- **Worktree accumulation / cleanup.** Repeated runs could leave stale worktrees. *Mitigation:* `WorktreeManager`
  reuses the per-session worktree (one per session, by the frozen path) and exposes teardown; full GC is a later
  hardening concern, noted not solved here.

## Open Questions

- The precise dirty-vs-clean finalize predicate (what counts as "changeset ready") is pinned to `git status` +
  the presence of a `changeset_ready` event; the changeset *content* computation is W3's diff/changeset work and
  is referenced, not built, here.
