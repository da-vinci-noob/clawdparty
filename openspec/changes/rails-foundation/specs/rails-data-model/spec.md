## ADDED Requirements

### Requirement: Rails 8 API-only application scaffold

The `api/` directory SHALL contain a Rails 8 API-only application configured for PostgreSQL 18. The application SHALL run inside the Docker dev runtime started by `bin/start`. The toolchain SHALL include RuboCop (with `rubocop-rails` and `rubocop-rspec`, line length 120, frozen string literals, required parentheses on method calls with arguments), RSpec, FactoryBot, and annotaterb for schema comments.

#### Scenario: Application boots in API-only mode against PostgreSQL

- **WHEN** the Rails app is started inside the Docker dev runtime via `bin/start`
- **THEN** it boots as an API-only Rails 8 app connected to PostgreSQL 18
- **AND** `config.api_only` is `true`

#### Scenario: Lint baseline is enforced

- **WHEN** RuboCop runs over `api/`
- **THEN** it loads `rubocop-rails` and `rubocop-rspec`, enforces a 120-character line length, frozen string literals, and required parentheses on method calls with arguments

### Requirement: Three logical databases for Solid Queue and Solid Cable

The application SHALL configure three PostgreSQL databases — `primary`, `queue`, and `cable` — with `ApplicationRecord` using `primary`, Solid Queue using `queue`, and Solid Cable using `cable`. No Redis SHALL be required for jobs or cable.

#### Scenario: Each subsystem uses its own database

- **WHEN** `db:prepare` is run
- **THEN** the primary application tables, the Solid Queue tables, and the Solid Cable tables are created in their respective `primary`, `queue`, and `cable` databases
- **AND** neither jobs nor cable depend on Redis

### Requirement: Eight-table data model with enums

The schema SHALL define exactly these eight tables: `users` (name); `sessions` (title, objective, status, repository_path, worktree_path, branch_name, base_branch, host_id); `invites` (token_digest, role, expires_at); `participants` (session, user, role, last_seen_at); `tasks` (title, status, owner, position); `ai_runs` (status, prompt, claude_session_id, model, base_sha, total_cost_usd, usage, diff_stats, requested_by, reviewed_by); `messages` (session, author participant, kind, body); and `events` (session_id, event_type, actor_kind, actor_participant_id, ai_run_id, seq, payload). `sessions.status` SHALL be an enum of `active`/`archived` (a minimal session-lifecycle set that MAY be extended additively in a later change); `participants.role` SHALL be an enum of `owner`/`editor`/`reviewer`/`viewer`; `tasks.status` SHALL be an enum of `todo`/`doing`/`review`/`done`/`blocked`; `messages.kind` SHALL be an enum of `user`/`claude`/`system`.

#### Scenario: All eight tables exist with their enums

- **WHEN** the schema is loaded
- **THEN** the `users`, `sessions`, `invites`, `participants`, `tasks`, `ai_runs`, `messages`, and `events` tables exist
- **AND** `sessions.status`, `participants.role`, `tasks.status`, and `messages.kind` are constrained to their enumerated value sets (`sessions.status` to `active`/`archived`)

#### Scenario: Each model has one minimal factory

- **WHEN** a model's FactoryBot factory is used in a spec
- **THEN** exactly one minimal factory per model exists, using `sequence` for any uniqueness, and it does not eagerly create unrelated associations

### Requirement: ai_runs state machine value set

The `ai_runs.status` enum SHALL include all nine states of the run state machine: `queued`, `running`, `awaiting_review`, `approved`, `rejected`, `superseded`, `completed_clean`, `failed`, and `interrupted`. The full value set SHALL exist in Week 1 even though run-orchestration transitions are deferred, so that the reject-severs-`claude_session_id`-chaining rule and the revise-supersedes rule can be encoded later without a schema change.

`ai_runs.status` SHALL be stored as a PostgreSQL native enum type (NOT an integer-backed Rails enum), so the partial unique index predicate `WHERE status IN ('queued','running','awaiting_review')` matches the stored string values directly. *Why:* the predicate compares against the string literals `'queued'`/`'running'`/`'awaiting_review'`; an integer-backed Rails enum would store `0`/`1`/`2`, the predicate would never match, and the one-active-run invariant would silently fail to enforce. Enums NOT referenced by any database constraint or index predicate (`participants.role`, `tasks.status`, `messages.kind`) MAY use string-backed Rails enums; the rule above binds only enums named in a `WHERE`/`CHECK` clause.

#### Scenario: All nine run states are representable

- **WHEN** the `ai_runs` schema is loaded
- **THEN** `status` accepts each of `queued`, `running`, `awaiting_review`, `approved`, `rejected`, `superseded`, `completed_clean`, `failed`, and `interrupted`
- **AND** `rejected`, `superseded`, and `approved` exist so the reject/revise correctness rules can be added in a later change without migrating the schema

#### Scenario: Constraint-referenced enum is stored as its string value

- **WHEN** an `ai_run` is persisted with status `running`
- **THEN** the stored `ai_runs.status` value is the string `'running'` (not an integer like `1`), so the partial unique index predicate `WHERE status IN ('queued','running','awaiting_review')` matches the stored value

### Requirement: One active run per session enforced at the database

There SHALL be a partial unique index on `ai_runs.session_id` scoped to `status IN ('queued', 'running', 'awaiting_review')`, so that the database — not Ruby — prevents a second active run for the same session.

#### Scenario: Second active run is rejected by the database

- **WHEN** a session already has an `ai_run` in `queued`, `running`, or `awaiting_review` and another active run for the same session is inserted
- **THEN** the database raises a uniqueness violation and the second active run is not created

#### Scenario: A non-active run does not block a new run

- **WHEN** a session's prior run is in a terminal status (such as `approved`, `rejected`, `completed_clean`, `failed`, `interrupted`, or `superseded`)
- **THEN** a new active run for that session can be created without violating the partial unique index

### Requirement: Idempotent event identity enforced at the database

There SHALL be a unique index on `events [ai_run_id, seq]` so that the pair `(ai_run_id, seq)` uniquely identifies a persisted event and duplicate inserts are rejected at the database. This realizes the idempotency rule defined by the frozen event-envelope capability. Because `ai_run_id` and `seq` are nullable, this unique index constrains only run-scoped events (rows with a non-null `ai_run_id`); Postgres treats nulls as distinct, which is correct because only sidecar run-events are idempotent-retry traffic. The global `events.id` SHALL be a server-assigned monotonic identifier used as the client backfill cursor for ALL events.

`events.session_id` SHALL be non-null and indexed — every event is session-scoped, enabling session-scoped backfill and broadcast. `events.ai_run_id` and `events.seq` SHALL be nullable: present for run-scoped events emitted by the sidecar, and null for session-scoped non-run events (chat, participant, presence, task).

The frozen event-envelope's first-class `ts` field SHALL be derived from `events.created_at` when an event row is serialized to the envelope, and SHALL NOT be stuffed into `payload`. `events.created_at` SHALL be serialized to the envelope `ts` as an ISO-8601 UTC timestamp with **millisecond precision and a `Z` suffix** (e.g. `2026-06-28T20:11:05.123Z`), matching the frozen event-envelope scalar contract exactly — NOT Rails' default timestamp JSON, which can emit a different fractional-second precision or a numeric offset and would produce the cross-stream mismatch the frozen contract guards against. There is no separate `ts` column; `events.created_at` is the single source of truth for the envelope `ts`.

`events.payload` SHALL be a `jsonb` column. Because Postgres treats `NULL`s as distinct under a unique index, the many session-scoped non-run events that share `ai_run_id IS NULL` (chat, participant, presence, task) do NOT collide with one another under the `(ai_run_id, seq)` unique index — the index constrains only run-scoped rows.

#### Scenario: Duplicate (ai_run_id, seq) is rejected at the database

- **WHEN** a run-scoped event (non-null `ai_run_id`) with an already-persisted `(ai_run_id, seq)` is inserted
- **THEN** the database raises a uniqueness violation, preventing a duplicate row

#### Scenario: events.id is the global cursor

- **WHEN** events are persisted across multiple runs in a session
- **THEN** each carries a server-assigned monotonic `id` usable as the cross-run client backfill cursor, independent of the per-run `seq`

#### Scenario: Non-run events are session-scoped without a run

- **WHEN** a chat_message or participant_joined event is persisted
- **THEN** it carries a non-null session_id and a null ai_run_id and seq, and still receives a monotonic global id
- **AND** multiple such events sharing `ai_run_id IS NULL` do not collide under the `(ai_run_id, seq)` unique index, because Postgres treats nulls as distinct

#### Scenario: Envelope ts is derived from created_at

- **WHEN** a persisted event row is serialized to the frozen event-envelope
- **THEN** its `ts` field is the row's `created_at` rendered as an ISO-8601 UTC timestamp with millisecond precision and a `Z` suffix (e.g. `2026-06-28T20:11:05.123Z`), matching the frozen scalar contract, and `ts` is not read from `payload`

### Requirement: Append-only events and messages with actor columns

The `events` and `messages` tables SHALL be append-only (no update/delete in normal operation). The `events` actor SHALL be stored as `actor_kind` (enum `claude`/`user`/`system`) plus a nullable `actor_participant_id`, reconstructing the frozen event-envelope actor discriminated union. `actor_participant_id` SHALL be non-null if and only if `actor_kind` is `user`; the originating participant id (not a display name and not a role) is stored.

#### Scenario: User-kind events carry a participant id; others do not

- **WHEN** an event row is written
- **THEN** if `actor_kind` is `user` it has a non-null `actor_participant_id`, and if `actor_kind` is `claude` or `system` its `actor_participant_id` is null
- **AND** a row violating this pairing is rejected by a database check constraint

#### Scenario: Persisted event_type is a frozen taxonomy member or ai_raw

- **WHEN** a durable event is persisted
- **THEN** its `event_type` is one of the 20 frozen type names in the event-envelope capability's taxonomy or `ai_raw` (the sidecar's normalizer fallback for unknown SDK message shapes)

### Requirement: Id fields serialize to the envelope as strings

The frozen event-envelope pins `actor.id`, `session_id`, and `ai_run_id` as STRING scalars, but Rails stores them as integer foreign keys (`actor_participant_id`, `session_id`, `ai_run_id`). When an event row is serialized to the Contract-1 envelope, `actor.id` (from `actor_participant_id`), `session_id`, and `ai_run_id` SHALL be serialized as STRING ids (stringified) to match the frozen envelope's scalar types, even though they are stored as integer foreign keys. A null `ai_run_id` (session-scoped non-run event) SHALL serialize as `null`, not the string `"null"`.

#### Scenario: Serialized envelope carries id fields as strings

- **WHEN** an event row stored with integer `actor_participant_id`, `session_id`, and `ai_run_id` foreign keys is serialized to the frozen event-envelope
- **THEN** the envelope's `actor.id`, `session_id`, and `ai_run_id` are STRING ids (stringified), matching the frozen envelope's scalar types
- **AND** a session-scoped event whose `ai_run_id` is null serializes `ai_run_id` as `null` (not the string `"null"`)

### Requirement: Column nullability posture separates W2-only fields from structural columns

The W2-only `ai_runs` columns — `base_sha`, `claude_session_id`, `reviewed_by`, `total_cost_usd`, `usage`, and `diff_stats` — SHALL be nullable so that the Week-1 replay/seed path can create runs without populating run-orchestration data that does not yet exist. The identity, enum, and structural columns — `ai_runs.status`, `ai_runs.prompt`, `ai_runs.model`, `events.session_id`, `events.event_type`, `events.actor_kind`, `participants.role`, and the foreign keys that always exist — SHALL be `NOT NULL`, so the load-bearing constraints and indexes always have a value to operate on. `ai_runs.prompt` and `ai_runs.model` are conceptually always-present (like `status`): a run is always requested with a prompt and a model, so they are structural NOT NULL rather than W2-only nullable.

#### Scenario: A W1 run is created with W2-only columns null

- **WHEN** the Week-1 replay/seed path creates an `ai_run` without `base_sha`, `claude_session_id`, `reviewed_by`, `total_cost_usd`, `usage`, or `diff_stats`
- **THEN** the run is persisted successfully with those W2-only columns null

#### Scenario: Structural columns reject null

- **WHEN** an attempt is made to persist a row with a null `ai_runs.status`, `ai_runs.prompt`, `ai_runs.model`, `events.session_id`, `events.event_type`, `events.actor_kind`, or `participants.role`
- **THEN** the database rejects the insert because those columns are `NOT NULL`
