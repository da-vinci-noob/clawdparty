import type { EnvelopeType } from "@clawdparty/contracts";

/**
 * The harness store's schema version. Bumping this REFUSES every existing store
 * rather than migrating it  — the harness reports the run
 * failed instead of guessing at an older layout.
 */
export const STORE_SCHEMA_VERSION = 1;

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
}

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
       * billed and may or may not have produced output. Both ids are reserved
       * BEFORE the request is dispatched so a synthetic outcome can be written
       * under the same identity after a crash.
       */
      phase: "request_pending";
      reservedEntrySeq: number;
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
  reservedEntrySeq: number;
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
  activeRunIds(): string[];
  maxStoreSeq(): number;
  reserveUsageId(): number;
  nextSeq(runId: string): number;
  heartbeat(): void;
  durability(): { journalMode: string; synchronous: number; foreignKeys: number };
  close(): Promise<void>;
}
