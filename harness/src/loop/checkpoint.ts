import type { LoopStore, Position, ReplayPolicy, ToolCallPosition, Write } from "../store/types.js";

export type { Position, ToolCallPosition, ReplayPolicy };

/**
 * The durable program counter.
 *
 * ONE register, overwritten TOTALLY after every step. Recovery READS it and
 * switches; it never replays the log to work out where it got to. That is what
 * makes recovery O(1) in session length  and why no code path may
 * consult `entries` to decide what to do next (invariant 6 — the marker is total, so
 * there is nothing to reconstruct).
 *
 * "Totally" is load-bearing and easy to erode: a partial update that merged with
 * the previous value would leave recovery reading a `phase` whose fields belong to
 * an earlier step. Every writer here passes a complete `Position`.
 */

export function positionWrite(runId: string, position: Position): Write {
  return { kind: "register", op: "set", namespace: "run.position", key: runId, value: position };
}

export function read(store: LoopStore, runId: string): Position | null {
  return store.readPosition(runId);
}

/** Write a position on its own. Most steps instead bundle it with their entries. */
export function write(store: LoopStore, runId: string, position: Position): void {
  store.commit({ writes: [positionWrite(runId, position)] });
}

// --- The effect sandwich ----------------------------------------------------
//
// Every uncertain external effect is bracketed by two commits, with identifiers
// RESERVED before the effect begins so a synthetic outcome can be written under
// the same identity after a crash:
//
//   TX[ position := request_pending, reserving entry n2 + usage u1 ]  ← intent
//         … provider request in flight …                             ← uncertain
//   TX[ insert entry n2, insert usage u1, position := tools(...) ]    ← settlement

export interface RequestIntent {
  settlementKey: string;
  reservedUsageId: number;
  requestSnapshotId: string;
  attempt: number;
  maxAttempts: number;
}

/**
 * Commit the INTENT to make a provider request. After this returns, a crash is
 * recoverable but its outcome is genuinely unknown — this is the ONLY permitted
 * uncertainty window.
 */
export function commitRequestIntent(
  store: LoopStore,
  runId: string,
  intent: RequestIntent,
  extraWrites: Write[] = [],
): Position {
  const position: Position = {
    phase: "request_pending",
    settlementKey: intent.settlementKey,
    reservedUsageId: intent.reservedUsageId,
    requestSnapshotId: intent.requestSnapshotId,
    attempt: intent.attempt,
    maxAttempts: intent.maxAttempts,
    notBeforeMs: 0,
  };
  store.commit({ writes: [...extraWrites, positionWrite(runId, position)] });
  return position;
}

/**
 * Fix the identity a request will settle under, before dispatching it.
 *
 * NOT a reserved `seq`. `seq` has exactly one allocator (the normalizer), and taking a
 * second opinion from `store.nextSeq` handed out ids the turn's own entries were about
 * to use — so `UNIQUE (run_id, seq)` rejected the settlement and the constraint meant to
 * stop a second one blocked the first. The settlement key cannot collide, because
 * ordinary entries do not have one.
 */
export function reserveForRequest(
  store: LoopStore,
  settlementKey: string,
): {
  settlementKey: string;
  reservedUsageId: number;
} {
  return { settlementKey, reservedUsageId: store.reserveUsageId() };
}

/**
 * Settle the request and move on, in ONE transaction. Writes apply in order, so
 * the entries land before the position that describes what comes next — which is
 * what lets the sandwich be two commits instead of four.
 */
export function settle(store: LoopStore, runId: string, writes: Write[], next: Position): void {
  store.commit({ writes: [...writes, positionWrite(runId, next)] });
}

// --- Tool phase -------------------------------------------------------------

/** The `tools` variant, extracted so callers can hold it without re-narrowing. */
export type ToolsPosition = Extract<Position, { phase: "tools" }>;

/**
 * Plan a turn's tool calls. Each call's result entry id is reserved up front and
 * each carries its own replay policy, so recovery can decide per call rather than
 * per turn.
 */
export function planTools(
  stepId: string,
  calls: Array<{ toolUseId: string; name: string; replay: ReplayPolicy }>,
): ToolsPosition {
  return {
    phase: "tools",
    stepId,
    calls: calls.map((call, index) => ({
      index,
      toolUseId: call.toolUseId,
      name: call.name,
      // The tool_use_id IS the settlement identity: unique, known before the effect
      // starts, and impossible to collide with the turn's own entries.
      settlementKey: call.toolUseId,
      replay: call.replay,
      status: "planned" as const,
    })),
  };
}

/**
 * Advance one call's status, returning a COMPLETE new position.
 *
 * Returned rather than mutated so no caller can persist a half-updated marker,
 * and typed `ToolsPosition → ToolsPosition` so advancing a call while NOT in the
 * tools phase is a compile error rather than a runtime throw.
 */
export function withCallStatus(
  position: ToolsPosition,
  index: number,
  status: ToolCallPosition["status"],
): ToolsPosition {
  return {
    ...position,
    calls: position.calls.map((call) => (call.index === index ? { ...call, status } : call)),
  };
}

export function allCallsCompleted(position: Position): boolean {
  return position.phase === "tools" && position.calls.every((c) => c.status === "completed");
}

// --- Recovery ---------------------------------------------------------------

/**
 * What a recovered run owes, decided from the position alone.
 *
 * `uncertain` is a first-class outcome, not an error path. After a crash in
 * `request_pending` the harness genuinely cannot know whether the request was
 * billed or produced output, and /AC4 requires the feed to SAY so rather than
 * imply either result. Never collapse it to success or failure to make a display
 * simpler.
 */
export type Recovery =
  | { action: "resume" }
  | { action: "settle_uncertain"; settlementKey: string; reservedUsageId: number }
  | {
      action: "finish_tools";
      position: Position;
      synthesize: ToolCallPosition[];
      reexecute: ToolCallPosition[];
      execute: ToolCallPosition[];
    }
  | { action: "recompact"; preparationId: string }
  | { action: "nothing_owed"; outcome: "finished" | "failed" | "interrupted" }
  | { action: "report_failed"; reason: "no_position" };

export function planRecovery(position: Position | null): Recovery {
  if (position === null) {
    // Never started, or already cleaned up by a terminal transaction.
    return { action: "report_failed", reason: "no_position" };
  }

  switch (position.phase) {
    case "checkpoint":
      return { action: "resume" };

    case "request_pending":
      return {
        action: "settle_uncertain",
        settlementKey: position.settlementKey,
        reservedUsageId: position.reservedUsageId,
      };

    case "tools": {
      const pending = position.calls.filter((c) => c.status === "effect_pending");
      return {
        action: "finish_tools",
        position,
        // `never` gets a SYNTHETIC interrupted result and is not re-run: every
        // call still has an outcome, so the transcript stays coherent, and
        // nothing executes twice.
        synthesize: pending.filter((c) => c.replay === "never"),
        reexecute: pending.filter((c) => c.replay === "safe"),
        // `planned` never STARTED, so no effect occurred and executing it is safe
        // whatever its replay policy says — a first execution, not a replay. The earlier
        // decision table omitted this status, so these calls were abandoned with
        // no tool_result at all, which a provider rejects outright.
        execute: position.calls.filter((c) => c.status === "planned"),
      };
    }

    case "compacting":
      // Deterministic over the logged region, so simply re-running is safe.
      return { action: "recompact", preparationId: position.preparationId };

    case "terminal":
      return { action: "nothing_owed", outcome: position.outcome };
  }
}
