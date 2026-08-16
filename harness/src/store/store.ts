import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  type CommitResult,
  type Entry,
  type HarnessStoreApi,
  LOCK_STALE_AFTER_MS,
  type Namespace,
  type OpenResult,
  type Position,
  type RegisterValue,
  STORE_SCHEMA_VERSION,
  type SessionLock,
  type Transaction,
  type UsageRow,
} from "./types.js";

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");

/**
 * `entriesFrom(n)` / `surfaceFrom(n)` are INCLUSIVE of `n`, so `entriesFrom(0)`
 * is the whole log.
 *
 * The HTTP projection cursor is `?after=<store_seq>`, which is EXCLUSIVE. The
 * conversion lives here and nowhere else — an off-by-one split across call sites
 * silently drops or duplicates exactly one event per request, which is the
 * hardest kind of projection bug to see.
 */
export function afterCursorToFrom(after: number): number {
  return after + 1;
}

/**
 * True only for a uniqueness/PK collision.
 *
 * Deliberately narrow. `INSERT OR IGNORE` would be shorter, but it swallows
 * EVERY constraint violation — a malformed entry (bad actor pairing, on-surface
 * with no blocks) would be silently dropped instead of aborting the transaction,
 * turning corruption into invisible data loss. Only a duplicate key is tolerable.
 */
function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}

export interface OpenOptions {
  /** Directory holding one DB file per session. */
  dir: string;
  /** Identity written into `session.lock`; defaults to a fresh uuid. */
  owner?: string;
  /** Reclaim a lock whose heartbeat is older than this. */
  staleAfterMs?: number;
}

export async function openStore(sessionId: string, opts: OpenOptions): Promise<OpenResult> {
  await mkdir(opts.dir, { recursive: true });
  const path = join(opts.dir, `session-${sessionId}.sqlite3`);

  let db: Database.Database;
  try {
    db = new Database(path);
  } catch (err) {
    return { ok: false, reason: "corrupt", detail: String(err) };
  }

  // journal_mode persists in the file; synchronous and foreign_keys are
  // PER-CONNECTION with build- and mode-dependent defaults. Measured on SQLite
  // 3.53.4: a newly created file inherits FULL, a reopened WAL file inherits
  // NORMAL — so the value is set explicitly on every open rather than inherited,
  // otherwise a session's FIRST run would commit under different durability than
  // every later one.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  try {
    db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  } catch (err) {
    db.close();
    return { ok: false, reason: "corrupt", detail: `schema apply failed: ${String(err)}` };
  }

  const found = readSchemaVersion(db);
  if (found === null) {
    seedMeta(db, sessionId);
  } else if (found !== STORE_SCHEMA_VERSION) {
    db.close();
    return {
      ok: false,
      reason: "incompatible_version",
      found,
      expected: STORE_SCHEMA_VERSION,
    };
  }

  const owner = opts.owner ?? randomUUID();
  const staleAfterMs = opts.staleAfterMs ?? LOCK_STALE_AFTER_MS;
  const incumbent = claimLock(db, owner, staleAfterMs);
  if (incumbent) {
    db.close();
    return { ok: false, reason: "locked", heldBy: incumbent };
  }

  return {
    ok: true,
    store: new HarnessStore(sessionId, db, owner),
    schemaVersion: STORE_SCHEMA_VERSION,
  };
}

function readSchemaVersion(db: Database.Database): number | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : null;
}

function seedMeta(db: Database.Database, sessionId: string): void {
  const insert = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  insert.run("schema_version", String(STORE_SCHEMA_VERSION));
  insert.run("session_id", sessionId);
  insert.run("created_at_ms", String(Date.now()));
}

/**
 * One writer per session. Returns the incumbent lock when the store is held by a
 * LIVE process, or null when the lock was acquired (including by reclaiming a
 * stale one).
 *
 * Reclaim is time-based because a crashed harness cannot release its own lock.
 * The threshold matches Rails' staleness sweep, so the two agree on when a
 * process is considered gone.
 */
function claimLock(db: Database.Database, owner: string, staleAfterMs: number): SessionLock | null {
  const acquire = db.transaction((): SessionLock | null => {
    const row = db
      .prepare("SELECT value FROM registers WHERE namespace = 'session.lock' AND key = 'session'")
      .get() as { value: string } | undefined;

    if (row) {
      const held = JSON.parse(row.value) as SessionLock;
      const fresh = Date.now() - held.heartbeatMs < staleAfterMs;
      if (fresh && held.owner !== owner) return held;
    }

    writeLock(db, owner);
    return null;
  });
  return acquire();
}

function writeLock(db: Database.Database, owner: string): void {
  const lock: SessionLock = { owner, pid: process.pid, heartbeatMs: Date.now() };
  db.prepare(
    `INSERT INTO registers (namespace, key, value, store_seq)
     VALUES ('session.lock', 'session', ?, COALESCE((SELECT MAX(store_seq) FROM entries), 0))
     ON CONFLICT (namespace, key) DO UPDATE SET value = excluded.value`,
  ).run(JSON.stringify(lock));
}

class HarnessStore implements HarnessStoreApi {
  readonly sessionId: string;
  private readonly db: Database.Database;
  private readonly owner: string;
  private closed = false;

  constructor(sessionId: string, db: Database.Database, owner: string) {
    this.sessionId = sessionId;
    this.db = db;
    this.owner = owner;
  }

  /**
   * The ONLY write primitive. All-or-none in one SQLite transaction, with writes
   * applied IN ORDER — which is what lets a register value reference an entry
   * created earlier in the same transaction, and therefore what makes the effect
   * sandwich two commits instead of four (invariants 1 and 5).
   */
  commit(tx: Transaction): CommitResult {
    this.assertOpen();
    const run = this.db.transaction((): CommitResult => {
      const storeSeqs: Array<number | null> = [];
      const skipped: number[] = [];

      tx.writes.forEach((write, index) => {
        switch (write.kind) {
          case "entry": {
            const seq = this.insertEntry(write.entry);
            storeSeqs.push(seq);
            if (seq === null) skipped.push(index);
            break;
          }
          case "usage":
            this.insertUsage(write.row);
            storeSeqs.push(null);
            break;
          case "register":
            if (write.op === "set") this.setRegister(write.namespace, write.key, write.value);
            else this.delRegister(write.namespace, write.key);
            storeSeqs.push(null);
            break;
        }
      });

      const first = storeSeqs.find((s): s is number => s !== null);
      return { firstStoreSeq: first ?? this.maxStoreSeq(), storeSeqs, skipped };
    });
    return run();
  }

  // Returns null when the entry was skipped as a duplicate — either (run_id, seq) for
  // ordinary ingest, or (run_id, settlement_key) for a settlement.
  private insertEntry(entry: Omit<Entry, "store_seq">): number | null {
    try {
      const info = this.db
        .prepare(
          `INSERT INTO entries
             (run_id, seq, type, actor_kind, actor_id, ts_ms, payload, blocks, on_surface,
              settlement_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.run_id,
          entry.seq,
          entry.type,
          entry.actor_kind,
          entry.actor_id,
          entry.ts_ms,
          JSON.stringify(entry.payload ?? {}),
          entry.blocks === null || entry.blocks === undefined ? null : JSON.stringify(entry.blocks),
          entry.on_surface,
          entry.settlement_key ?? null,
        );
      return Number(info.lastInsertRowid);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Two idempotency rules land here, and they cover different things. A duplicate
      // (run_id, seq) is replayed ingest. A duplicate (run_id, settlement_key) is a
      // SECOND settlement of one uncertain effect — which is what makes a crash during
      // recovery safe (invariant 7). Ordinary entries carry no key, so they can never
      // be blocked by the second rule; that was the bug this replaced.
      return null;
    }
  }

  private insertUsage(row: Omit<UsageRow, "id"> & { id?: number }): void {
    try {
      this.db
        .prepare(
          `INSERT INTO usage
             (id, run_id, entry_store_seq, provider, model,
              input_tokens, output_tokens, cache_read, cache_creation, ts_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id ?? null,
          row.run_id,
          row.entry_store_seq,
          row.provider,
          row.model,
          row.input_tokens,
          row.output_tokens,
          row.cache_read,
          row.cache_creation,
          row.ts_ms,
        );
    } catch (err) {
      // Only a re-settlement under an already-used reserved id is tolerable.
      if (!isUniqueViolation(err)) throw err;
    }
  }

  private setRegister(namespace: Namespace, key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO registers (namespace, key, value, store_seq)
         VALUES (?, ?, ?, COALESCE((SELECT MAX(store_seq) FROM entries), 0))
         ON CONFLICT (namespace, key)
           DO UPDATE SET value = excluded.value, store_seq = excluded.store_seq`,
      )
      .run(namespace, key, JSON.stringify(value));
  }

  private delRegister(namespace: Namespace, key: string): void {
    this.db.prepare("DELETE FROM registers WHERE namespace = ? AND key = ?").run(namespace, key);
  }

  /**
   * A primary-key point read, and deliberately nothing more. Recovery must not
   * scan `entries` (invariant 9) — that is what keeps recovery time flat as a
   * session's history grows by orders of magnitude.
   */
  readPosition(runId: string): Position | null {
    return this.readRegister("run.position", runId);
  }

  readRegister<N extends Namespace>(ns: N, key: string): RegisterValue<N> | null {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT value FROM registers WHERE namespace = ? AND key = ?")
      .get(ns, key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as RegisterValue<N>) : null;
  }

  surfaceFrom(storeSeq: number): Entry[] {
    this.assertOpen();
    return this.hydrate(
      this.db
        .prepare(
          "SELECT * FROM entries WHERE on_surface = 1 AND store_seq >= ? ORDER BY store_seq ASC",
        )
        .all(storeSeq),
    );
  }

  entriesFrom(storeSeq: number): Entry[] {
    this.assertOpen();
    return this.hydrate(
      this.db
        .prepare("SELECT * FROM entries WHERE store_seq >= ? ORDER BY store_seq ASC")
        .all(storeSeq),
    );
  }

  /**
   * The  reconciliation source: the harness's own answer to "what is
   * running?", read from position registers rather than inferred from the log. A
   * terminal position owes nothing, so it is not active.
   */
  activeRunIds(): string[] {
    this.assertOpen();
    const rows = this.db
      .prepare("SELECT key, value FROM registers WHERE namespace = 'run.position'")
      .all() as Array<{ key: string; value: string }>;
    return rows
      .filter((r) => (JSON.parse(r.value) as Position).phase !== "terminal")
      .map((r) => r.key);
  }

  maxStoreSeq(): number {
    this.assertOpen();
    const row = this.db.prepare("SELECT COALESCE(MAX(store_seq), 0) AS m FROM entries").get() as {
      m: number;
    };
    return row.m;
  }

  /** Allocate a usage id up front so a request can be settled under it later. */
  reserveUsageId(): number {
    this.assertOpen();
    const row = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM usage").get() as {
      m: number;
    };
    return row.m + 1;
  }

  /** The next per-run `seq`. Reserving one means writing under it later. */
  nextSeq(runId: string): number {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM entries WHERE run_id = ?")
      .get(runId) as { m: number };
    return row.m + 1;
  }

  heartbeat(): void {
    this.assertOpen();
    writeLock(this.db, this.owner);
  }

  /**
   * The durability settings THIS connection is actually running under. Exposed
   * because `synchronous` and `foreign_keys` are per-connection: no outside
   * observer can read them, so without this the pinned durability tradeoff is
   * unassertable and could silently revert.
   */
  durability(): { journalMode: string; synchronous: number; foreignKeys: number } {
    this.assertOpen();
    return {
      journalMode: String(this.db.pragma("journal_mode", { simple: true })),
      synchronous: Number(this.db.pragma("synchronous", { simple: true })),
      foreignKeys: Number(this.db.pragma("foreign_keys", { simple: true })),
    };
  }

  /**
   * A CLEAN close RELEASES the session lock. This writer is voluntarily giving up the
   * record, so leaving the lock behind made a graceful restart wait out the 15s
   * staleness window before it could reopen its own store — and during that window boot
   * recovery skips every session while every run start fails "store unavailable".
   *
   * Crash detection is unaffected, and this is what sharpens it: a CRASH leaves the lock
   * (there was no close), so staleness now means "the writer died" rather than "the
   * writer died OR shut down recently".
   */
  async close(): Promise<void> {
    if (this.closed) return;
    try {
      this.db
        .prepare("DELETE FROM registers WHERE namespace = 'session.lock' AND key = 'session'")
        .run();
    } catch {
      // A failed release must not stop the close: the lock ages out either way, and a
      // half-closed store with a live handle is worse than a stale lock.
    }
    this.closed = true;
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("harness store is closed");
  }

  private hydrate(rows: unknown[]): Entry[] {
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      store_seq: r.store_seq as number,
      run_id: r.run_id as string | null,
      seq: r.seq as number | null,
      type: r.type as Entry["type"],
      actor_kind: r.actor_kind as Entry["actor_kind"],
      actor_id: r.actor_id as string | null,
      ts_ms: r.ts_ms as number,
      payload: JSON.parse(r.payload as string),
      blocks: r.blocks === null ? null : (JSON.parse(r.blocks as string) as unknown[]),
      on_surface: r.on_surface as 0 | 1,
      settlement_key: (r.settlement_key as string | null) ?? null,
    }));
  }
}
