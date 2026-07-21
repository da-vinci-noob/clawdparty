## MODIFIED Requirements

### Requirement: Eight-table data model with enums

The schema SHALL define exactly these eight tables: `users` (name); `sessions` (title, objective, status, repository_path, worktree_path, branch_name, base_branch, host_id, **last_activity_at**); `invites` (token_digest, role, expires_at); `participants` (session, user, role, last_seen_at); `tasks` (title, status, owner, position); `ai_runs` (status, prompt, claude_session_id, model, base_sha, total_cost_usd, usage, diff_stats, requested_by, reviewed_by); `messages` (session, author participant, kind, body); and `events` (session_id, event_type, actor_kind, actor_participant_id, ai_run_id, seq, payload). `sessions.status` SHALL be an enum of `active`/`archived` (a minimal session-lifecycle set that MAY be extended additively in a later change); `participants.role` SHALL be an enum of `owner`/`editor`/`reviewer`/`viewer`; `tasks.status` SHALL be an enum of `todo`/`doing`/`review`/`done`/`blocked`; `messages.kind` SHALL be an enum of `user`/`claude`/`system`.

`sessions.last_activity_at` SHALL be a timestamp recording the session's most recent activity, used to order the per-user session list (`session-history`). It SHALL be set on session creation (defaulting to the session's `created_at`) and SHALL be advanced to the current time whenever an event is appended for the session (in the same transaction as the append — see the append-only requirement below). Existing sessions SHALL be backfilled to their `created_at` by the migration so ordering is well-defined without a data job.

#### Scenario: All eight tables exist with their enums

- **WHEN** the schema is loaded
- **THEN** the `users`, `sessions`, `invites`, `participants`, `tasks`, `ai_runs`, `messages`, and `events` tables exist
- **AND** `sessions.status`, `participants.role`, `tasks.status`, and `messages.kind` are constrained to their enumerated value sets (`sessions.status` to `active`/`archived`)
- **AND** `sessions.last_activity_at` exists as a timestamp column

#### Scenario: Each model has one minimal factory

- **WHEN** a model's FactoryBot factory is used in a spec
- **THEN** exactly one minimal factory per model exists, using `sequence` for any uniqueness, and it does not eagerly create unrelated associations

#### Scenario: Appending an event advances the session's last_activity_at

- **WHEN** an event is appended for a session
- **THEN** the session's `last_activity_at` is advanced to the append time within the same transaction as the event insert
