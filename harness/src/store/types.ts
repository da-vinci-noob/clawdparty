import type { EnvelopeType } from "@clawdparty/contracts";

/**
 * The harness store's schema version. Bumping this REFUSES every existing store
 * rather than migrating it  — the harness reports the run
 * failed instead of guessing at an older layout.
 */
export const STORE_SCHEMA_VERSION = 3;

/** Staleness threshold, shared with Rails' Harness::HealthcheckJob. */
export const LOCK_STALE_AFTER_MS = 15_000;

export type ActorKind = "claude" | "user" | "system";

export interface Entry {
  store_seq: number;
  run_id: string | null;
  seq: number | null;
  type: EnvelopeType;
  actor_kind: ActorKind;
  actor_id: string | null;
  ts_ms: number;
  payload: unknown;
  /**
   * The UNTOUCHED provider content-block array. Required whenever
   * `on_surface` is 1 and enforced by a CHECK constraint: server-side
   * compaction returns a `compaction` block that the next request needs
   * verbatim, and extracting only its text silently loses the compaction state
   * (R6). Thinking blocks have the same constraint — they must be echoed back
   * unedited or the provider rejects them.
   */
  blocks: unknown[] | null;
  /** 1 = contributes to model history, i.e. is part of the request surface. */
  on_surface: 0 | 1;
  /**
   * 1 = belongs in the `events` projection; 0 = store-only, written for request
   * reconstruction and never sent to a client.
   *
   * Required, not optional-with-a-default: the two kinds are not distinguishable
   * from an entry's other fields (see schema.sql), so every write site has to say
   * which it is and tsc is what asks.
   */
  emitted: 0 | 1;
  /**
   * The settlement identity of an uncertain effect; NULL for an ordinary entry.
   * `UNIQUE (run_id, settlement_key)` is what makes a settlement single-use, so a
   * crash DURING recovery cannot double-settle. See schema.sql for why this replaced
   * reserving a `seq`.
   */
  settlement_key?: string | null;
}

/**
 * The store as the LOOP may use it: everything except `allocateSeq`.
 *
 * The omission is the enforcement. While a run is executing, its normalizer is the single
 * seq allocator; `store.allocateSeq` in loop code is now a compile error rather than a
 * rule someone has to remember.
 */
export type LoopStore = Omit<HarnessStoreApi, "allocateSeq">;

export interface UsageRow {
  id: number;
  run_id: string;
  entry_store_seq: number | null;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_creation: number;
  ts_ms: number;
}

/**
 * Register namespaces. Exactly these — adding one is a store-schema change.
 *
 * `session.lock` is present here but was ABSENT from the schema's own list, which
 * declared itself exhaustive, while the store's behavioural contract requires it
 * ("a `session.lock` register holding the owning process's identity plus a
 * heartbeat timestamp"). Resolved in favour of the behavioural contract, since
 * one-writer-per-session is not optional. Recorded rather than silently reconciled.
 */
export type Namespace =
  | "run.meta"
  | "run.position"
  | "run.tool_args"
  | "run.result"
  | "lane.leaf"
  | "lane.state"
  | "session.plugins"
  | "session.fact"
  | "session.lock";

/**
 * The durable program counter. Written to `registers('run.position', runId)`
 * after EVERY step.
 *
 * TOTAL by construction: no variant depends on a previous value, so recovery
 * READS it and switches, rather than replaying the log to work out where it got
 * to. That property is what makes recovery O(1) in session length , and
 * it is why no code path may consult `entries` to decide what to do next
 * (invariant 6).
 */
export type Position =
  | { phase: "checkpoint" }
  | {
      /**
       * THE ONLY PERMITTED UNCERTAINTY WINDOW. The request may have been
       * billed and may or may not have produced output. The identity is fixed
       * BEFORE the request is dispatched so a synthetic outcome can be written
       * under the same identity after a crash.
       */
      phase: "request_pending";
      /** Settlement identity, NOT a reserved seq — see schema.sql. */
      settlementKey: string;
      reservedUsageId: number;
      requestSnapshotId: string;
      attempt: number;
      maxAttempts: number;
      notBeforeMs: number;
    }
  | {
      phase: "tools";
      stepId: string;
      calls: ToolCallPosition[];
    }
  | { phase: "compacting"; preparationId: string }
  | { phase: "terminal"; outcome: "finished" | "failed" | "interrupted" };

export interface ToolCallPosition {
  index: number;
  toolUseId: string;
  name: string;
  /**
   * Settlement identity, NOT a reserved seq. It IS the `toolUseId`: already unique,
   * already known before the effect starts, and it cannot collide with the turn's own
   * entries because those carry no settlement key at all.
   */
  settlementKey: string;
  /**
   * Declared by the tool, defaulting to `never` for anything undeclared
   *. `never` means a crash mid-effect writes a synthetic interrupted
   * result instead of re-running — the conversation stays coherent and nothing
   * executes twice.
   */
  replay: ReplayPolicy;
  status: "planned" | "effect_pending" | "completed";
}

export type ReplayPolicy = "safe" | "never";

export interface SessionLock {
  /** Process identity — enough to tell "me" from "someone else". */
  owner: string;
  pid: number;
  heartbeatMs: number;
}

/** Value shape per namespace. Only the load-bearing ones are pinned. */
export interface RegisterValues {
  "run.meta": RunMeta;
  "run.position": Position;
  "run.tool_args": unknown;
  "run.result": RunResult;
  "lane.leaf": { storeSeq: number };
  "lane.state": { currentRunId: string | null; pendingNext: string | null };
  "session.plugins": Array<{ id: string; version: string; origin: "bundled" | "external" }>;
  "session.fact": unknown;
  "session.lock": SessionLock;
}

export type RegisterValue<N extends Namespace> = RegisterValues[N];

export interface RunMeta {
  prompt: string;
  requestedBy: string;
  provider: string;
  model: string;
  cwd: string;
  baseSha: string | null;
  lane: string;
}

export interface RunResult {
  outcome: "finished" | "failed" | "interrupted";
  /**
   * True when the harness cannot know whether the final request took effect.
   * Never defaulted to false to simplify a display — /AC4 requires the feed to
   * state the uncertainty rather than imply either outcome.
   */
  uncertain: boolean;
  stopReason: string | null;
  endedAtMs: number;
}

// --- Write primitives -------------------------------------------------------

export type Write =
  | { kind: "entry"; entry: Omit<Entry, "store_seq"> }
  | { kind: "usage"; row: Omit<UsageRow, "id"> & { id?: number } }
  | { kind: "register"; op: "set"; namespace: Namespace; key: string; value: unknown }
  | { kind: "register"; op: "del"; namespace: Namespace; key: string };

export interface Transaction {
  writes: Write[];
  /**
   * The lane these writes belong to.
   *
   * When set, `commit` advances `lane.leaf` to the highest `store_seq` this transaction produced,
   * INSIDE the same transaction. That atomicity is the whole point of "serialize lanes at the
   * COMMIT boundary, not the run boundary": two lanes progress concurrently, and what has to be
   * indivisible is one lane's entries together with the marker saying where that lane now ends.
   * Advancing the leaf in a second transaction would let the other lane observe entries that no
   * leaf yet covers, or a leaf pointing past entries that were rolled back.
   *
   * Omitted by callers that are not lane-scoped (recovery bookkeeping, session locks), which is
   * why it is optional rather than defaulted to "main" — a default would silently attribute
   * session-level writes to a lane.
   */
  lane?: string;
}

export interface CommitResult {
  firstStoreSeq: number;
  /**
   * One entry per WRITE, in order, so a caller can correlate positionally.
   * `null` marks a write that produced no new store_seq: a register op, or an
   * entry skipped as a duplicate `(run_id, seq)`.
   */
  storeSeqs: Array<number | null>;
  /** Indices of entry writes silently skipped as duplicates (invariant 4). */
  skipped: number[];
}

export type OpenResult =
  | { ok: true; store: HarnessStoreApi; schemaVersion: number }
  | { ok: false; reason: "incompatible_version"; found: number; expected: number }
  | { ok: false; reason: "corrupt"; detail: string }
  | { ok: false; reason: "locked"; heldBy: SessionLock };

export interface HarnessStoreApi {
  readonly sessionId: string;
  commit(tx: Transaction): CommitResult;
  readPosition(runId: string): Position | null;
  readRegister<N extends Namespace>(ns: N, key: string): RegisterValue<N> | null;
  surfaceFrom(storeSeq: number): Entry[];
  entriesFrom(storeSeq: number): Entry[];
  /**
   * Entries that belong in the `events` projection — `entriesFrom` minus the store-only
   * ones. The single definition of the filter, so re-derivation consumes it instead
   * of restating the predicate in Ruby.
   */
  projectionFrom(storeSeq: number): Entry[];

  /**
   * The run's usage ledger, oldest first.
   *
   * Exposed because `entry_store_seq` on these rows is the only per-TURN record of where a
   * request's folded prefix ended — `request_header` is emit-on-change, so an unchanged turn emits
   * no marker. `reconstruct` reads these to rebuild an INTERMEDIATE request; without a read path
   * the column would be written and consulted by nothing, which is the defect it exists to fix.
   */
  usageRows(runId: string): UsageRow[];
  activeRunIds(): string[];
  maxStoreSeq(): number;
  /** An entry's own position, by `(run_id, seq)`. Null when there is no such entry. */
  storeSeqFor(runId: string, seq: number): number | null;
  reserveUsageId(): number;
  /**
   * The highest per-run `seq` already WRITTEN. A read, not an allocation — it exists so a
   * resumed run can seed its normalizer from where the previous one stopped.
   */
  highestSeq(runId: string): number;
  /**
   * Allocate the next per-run `seq`.
   *
   * ONLY legitimate where no normalizer is live — i.e. recovery, which runs after the loop
   * that owned the counter is gone. It is deliberately ABSENT from `LoopStore`, so loop
   * code cannot reach it: while a normalizer is running it is the sole allocator, and a
   * second one reading MAX(seq) hands out ids the normalizer is about to use. That bug
   * (UNIQUE (run_id, seq) silently dropping the write) was introduced twice from a rule
   * written in a comment, which is why it is now a type.
   */
  allocateSeq(runId: string): number;
  heartbeat(): void;
  durability(): { journalMode: string; synchronous: number; foreignKeys: number };
  close(): Promise<void>;
}
