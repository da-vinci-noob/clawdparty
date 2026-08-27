-- Harness store — one SQLite database per session.
--
-- Authoritative for the event log and recovery state. Postgres
-- `events` is a projection of `entries`.
--
-- PRAGMA scope, which is easy to get wrong and silent when wrong:
--   journal_mode  PERSISTENT — stored in the file, survives reopen.
--   synchronous   PER-CONNECTION, and its default is BUILD- and MODE-dependent
--                 (SQLITE_DEFAULT_SYNCHRONOUS vs SQLITE_DEFAULT_WAL_SYNCHRONOUS).
--                 Measured on SQLite 3.53.4: a newly created file reports FULL,
--                 while reopening an already-WAL file reports NORMAL. Same build,
--                 two different answers — which is exactly why it is set
--                 explicitly rather than inherited.
--   foreign_keys  PER-CONNECTION; default also build-dependent.
-- Both are therefore ALSO set in store.ts on every open. This copy only covers
-- first creation, where the inherited value would otherwise be FULL.
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL; -- deliberate durability tradeoff, asserted via store.ts
PRAGMA foreign_keys = ON;

-- ── Versioning ──────────────────────────────────────────────────────────────
-- /: refuse to misread state from an incompatible version. Refusal,
-- never migration — guessing at an older layout is how a record silently lies.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── The append-only log ─────────────────────────────────────────────────────
-- `store_seq` is session-wide monotonic and is the projection cursor; `seq` is
-- the per-run value the Contract-1 envelope already carries.
--
-- UNIQUE (run_id, seq) makes ingest idempotent: a replayed batch re-inserts the
-- same pair and is skipped. It does NOT enforce invariant 7 ("a reserved id is
-- used at most once") — that moved to UNIQUE (run_id, settlement_key) when
-- reserving a seq turned out to collide with the normalizer's own allocation.
-- See the settlement_key comment below.
CREATE TABLE IF NOT EXISTS entries (
  store_seq   INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT,
  seq         INTEGER,
  type        TEXT NOT NULL,
  actor_kind  TEXT NOT NULL,
  actor_id    TEXT,
  ts_ms       INTEGER NOT NULL,
  payload     TEXT NOT NULL,
  blocks      TEXT,
  on_surface  INTEGER NOT NULL DEFAULT 0,
  -- The SETTLEMENT IDENTITY of an uncertain effect, NULL for an ordinary entry.
  --
  -- This replaces reserving a `seq` up front, which did not work: `seq` has one
  -- allocator (the normalizer) and reserving from a second one handed the same id to
  -- the turn's own entries, so UNIQUE (run_id, seq) rejected the settlement — the
  -- constraint meant to stop a SECOND settlement was blocking the FIRST. A settlement
  -- key cannot collide with ordinary allocation because ordinary entries do not have
  -- one, and SQLite permits many NULLs in a UNIQUE index, which is exactly the shape
  -- needed: unique among settlements, absent everywhere else.
  --
  -- For a tool call the key is its `tool_use_id`, already unique and already known
  -- before the effect starts. For a provider request it is the run's turn identity.
  settlement_key TEXT,
  -- 1 = belongs in the Postgres `events` projection; 0 = the harness wrote it for
  -- request reconstruction and no client ever sees it (the per-call tool results,
  -- recovery's settlements).
  --
  -- Stated rather than derived, because every derivation is wrong. `seq IS NULL`
  -- catches session-scoped entries, which have no per-run seq and ARE emitted —
  -- filtering on it would silently drop every chat message from a re-derived feed.
  -- `seq IS NULL AND settlement_key IS NOT NULL` is accurate today only because all
  -- three store-only writes happen to carry a key; nothing made that true.
  --
  -- DEFAULT 1 is the safe direction: a write site that forgets it produces a visible
  -- phantom rather than an invisible omission.
  emitted INTEGER NOT NULL DEFAULT 1,
  UNIQUE (run_id, seq),
  UNIQUE (run_id, settlement_key),
  CHECK (emitted IN (0, 1)),
  -- A withheld entry must not consume a seq: seq is the per-run counter for the
  -- EMITTED stream, and a hole in it reads to the web reducer as a dropped event.
  CHECK (emitted = 1 OR seq IS NULL),
  -- The converse. An emitted run-scoped entry with no seq has no position in its
  -- run's stream, so no client can order it — the defect the fixture recapture
  -- found in `recovery_applied`. Session-scoped entries are exempt: `seq` is
  -- per-run, so they legitimately have none.
  CHECK (emitted = 0 OR run_id IS NULL OR seq IS NOT NULL),
  -- Validation rule 4: an entry on the model surface must carry verbatim blocks.
  -- Flattening to text loses compaction and thinking state (R6), so an on-surface
  -- entry without blocks is unusable for request reconstruction.
  CHECK (on_surface = 0 OR blocks IS NOT NULL),
  CHECK (actor_kind IN ('claude', 'user', 'system')),
  -- Mirrors the Contract-1 rule and the Postgres check: actor_id iff user.
  CHECK ((actor_kind = 'user') = (actor_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_entries_run     ON entries (run_id, seq);
CREATE INDEX IF NOT EXISTS idx_entries_surface ON entries (on_surface, store_seq);

-- Insert-only, enforced by trigger rather than convention (invariant 2). An
-- UPDATE or DELETE against the log is corruption, not a mistake to tolerate.
CREATE TRIGGER IF NOT EXISTS entries_no_update
BEFORE UPDATE ON entries
BEGIN
  SELECT RAISE(ABORT, 'entries is insert-only: UPDATE is corruption');
END;

CREATE TRIGGER IF NOT EXISTS entries_no_delete
BEFORE DELETE ON entries
BEGIN
  SELECT RAISE(ABORT, 'entries is insert-only: DELETE is corruption');
END;

-- ── Mutable current state (the only mutable table) ──────────────────────────
-- One row per (namespace, key), overwritten in place with no history. This is
-- what makes recovery a point read instead of a replay: `run.position` is a
-- TOTAL marker, so reading one row determines everything a run owes.
CREATE TABLE IF NOT EXISTS registers (
  namespace  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  store_seq  INTEGER NOT NULL,
  PRIMARY KEY (namespace, key)
) WITHOUT ROWID;

-- ── Append-only consumption ledger  ─────────────────────────────────
-- `id` is AUTOINCREMENT but may be supplied explicitly, which is how a usage row
-- is RESERVED before a request goes out and settled under the same identity
-- afterwards.
CREATE TABLE IF NOT EXISTS usage (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL,
  entry_store_seq INTEGER,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  input_tokens    INTEGER NOT NULL,
  output_tokens   INTEGER NOT NULL,
  cache_read      INTEGER NOT NULL,
  cache_creation  INTEGER NOT NULL,
  ts_ms           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_run ON usage (run_id);

CREATE TRIGGER IF NOT EXISTS usage_no_update
BEFORE UPDATE ON usage
BEGIN
  SELECT RAISE(ABORT, 'usage is append-only: UPDATE is corruption');
END;
