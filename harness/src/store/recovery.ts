import type { EventEnvelope, RecoveryAppliedPayload } from "@clawdparty/contracts";
import * as checkpoint from "../loop/checkpoint.js";
import type { Recovery, ToolCallPosition } from "../loop/checkpoint.js";
import type { HarnessStoreApi, Position, Write } from "./types.js";

/**
 * The recovery EXECUTOR. `checkpoint.planRecovery` decides what a run owes by reading
 * one register; this performs it.
 *
 * The split is deliberate. The decision is a pure function of the position marker, so
 * it is exhaustively testable without a store, a provider, or a tool. Execution needs
 * all three. Keeping them in one place would make the decision table — the thing
 * correctness actually rests on — only reachable through I/O.
 *
 * O(1) IN SESSION LENGTH : nothing here reads `entries`. Recovery switches on
 * the position and writes; it never replays the log to work out where it got to. A
 * `SELECT` over entries added anywhere in this file breaks the recovery budget on
 * exactly the long sessions that need it most (invariant 6).
 */

export interface ReexecuteResult {
  ok: boolean;
  text: string;
}

export interface RecoveryDeps {
  now: () => number;
  /**
   * Re-run a `replay: "safe"` call. Injected because the tool registry belongs to the
   * loop; recovery decides WHETHER to re-run, never HOW.
   */
  reexecute?: (call: ToolCallPosition, args: unknown) => Promise<ReexecuteResult>;
}

export interface RecoveryOutcome {
  plan: Recovery;
  fromPhase: string;
  action: RecoveryAppliedPayload["action"];
  uncertain: boolean;
  synthesized: number;
  reexecuted: number;
  /** `recovery_applied`, plus a synthetic settlement event per interrupted call. */
  events: EventEnvelope[];
  /** True when the run is over and Rails should be told. */
  terminal: boolean;
}

const INTERRUPTED = "[interrupted: the harness restarted while this was running]";
const UNCERTAIN =
  "[interrupted: the harness restarted after this request was sent. It may have been " +
  "billed, and may or may not have produced output. The outcome is genuinely unknown.]";

export async function applyRecovery(
  store: HarnessStoreApi,
  runId: string,
  deps: RecoveryDeps,
): Promise<RecoveryOutcome> {
  const position = checkpoint.read(store, runId);
  const plan = checkpoint.planRecovery(position);
  const fromPhase = position?.phase ?? "absent";

  switch (plan.action) {
    case "resume":
      return outcome(plan, fromPhase, "resumed", false, 0, 0, [], false, runId, deps);

    case "settle_uncertain":
      return settleUncertain(store, runId, plan, fromPhase, deps);

    case "finish_tools":
      return finishTools(store, runId, plan, fromPhase, deps);

    case "recompact":
      // Deterministic over the logged region, so the loop simply redoes it. Position
      // returns to `checkpoint` because compaction is not an effect to settle.
      checkpoint.write(store, runId, { phase: "checkpoint" });
      return outcome(plan, fromPhase, "replayed", false, 0, 0, [], false, runId, deps);

    case "nothing_owed":
      // A terminal position means the terminal transaction already ran. Nothing to
      // write; Rails may still be behind, so this is reported rather than silent.
      return outcome(plan, fromPhase, "resumed", false, 0, 0, [], true, runId, deps);

    case "report_failed":
      return outcome(plan, fromPhase, "failed", false, 0, 0, [], true, runId, deps);
  }
}

/**
 * The one permitted uncertainty window.
 *
 * Settled under the RESERVED entry id, which is what makes this safe to attempt more
 * than once: the store's UNIQUE (run_id, seq) rejects a second write under the same id,
 * so a crash DURING recovery cannot double-settle (invariant 7).
 *
 * `uncertain: true` is never collapsed to success or failure. The request may have been
 * billed and may have produced output nobody recorded; claiming either would put a
 * statement in the record that the harness cannot support.
 */
function settleUncertain(
  store: HarnessStoreApi,
  runId: string,
  plan: Extract<Recovery, { action: "settle_uncertain" }>,
  fromPhase: string,
  deps: RecoveryDeps,
): RecoveryOutcome {
  const ts = deps.now();
  const writes: Write[] = [
    {
      kind: "entry",
      entry: {
        run_id: runId,
        seq: plan.reservedEntrySeq,
        type: "run_interrupted",
        actor_kind: "system",
        actor_id: null,
        ts_ms: ts,
        payload: { reason: "harness_restart", uncertain: true, detail: UNCERTAIN },
        blocks: null,
        // NOT on the surface: an uncertain turn must not be replayed to the model as
        // though it were an assistant message. The next request folds from before it.
        on_surface: 0,
      },
    },
    checkpoint.positionWrite(runId, { phase: "terminal", outcome: "interrupted" }),
  ];
  store.commit({ writes });

  return {
    plan,
    fromPhase,
    action: "abandoned",
    uncertain: true,
    synthesized: 1,
    reexecuted: 0,
    events: [recoveryEvent(runId, fromPhase, "abandoned", true, ts)],
    terminal: true,
  };
}

/**
 * Settle `never` calls synthetically and re-run `safe` ones.
 *
 * The asymmetry is the whole point. A `bash` command may already have deleted a branch
 * or pushed a commit, so re-running it is the one outcome that must never happen — but
 * leaving the call with NO result would hand the model a conversation where a tool was
 * called and never answered, which it cannot reason about. So it gets an interrupted
 * result: nothing runs twice, and every call has an outcome.
 */
async function finishTools(
  store: HarnessStoreApi,
  runId: string,
  plan: Extract<Recovery, { action: "finish_tools" }>,
  fromPhase: string,
  deps: RecoveryDeps,
): Promise<RecoveryOutcome> {
  const ts = deps.now();
  let position = plan.position as checkpoint.ToolsPosition;
  const events: EventEnvelope[] = [];

  for (const call of plan.synthesize) {
    position = checkpoint.withCallStatus(position, call.index, "completed");
    store.commit({
      writes: [
        {
          kind: "entry",
          entry: {
            run_id: runId,
            seq: call.reservedEntrySeq,
            type: "tool_failed",
            actor_kind: "system",
            actor_id: null,
            ts_ms: ts,
            payload: {
              tool_use_id: call.toolUseId,
              name: call.name,
              error: INTERRUPTED,
              recovered: true,
            },
            // ON the surface: the model must see that this call was answered, or the
            // next request would contain a tool_use with no tool_result and the
            // provider would reject it.
            blocks: [
              {
                type: "tool_result",
                tool_use_id: call.toolUseId,
                content: [{ type: "text", text: INTERRUPTED }],
                is_error: true,
              },
            ],
            on_surface: 1,
          },
        },
        checkpoint.positionWrite(runId, position),
      ],
    });
  }

  let reexecuted = 0;
  for (const call of plan.reexecute) {
    // Args come from the RECORD (`run.tool_args`, persisted at clearance), not
    // from memory — memory is what the crash destroyed.
    const args = store.readRegister?.("run.tool_args", `${position.stepId}:${call.index}`) ?? null;
    const result = deps.reexecute
      ? await deps.reexecute(call, args)
      : { ok: false, text: INTERRUPTED };
    reexecuted += 1;
    position = checkpoint.withCallStatus(position, call.index, "completed");
    store.commit({
      writes: [
        {
          kind: "entry",
          entry: {
            run_id: runId,
            seq: call.reservedEntrySeq,
            type: result.ok ? "tool_finished" : "tool_failed",
            actor_kind: "system",
            actor_id: null,
            ts_ms: ts,
            payload: {
              tool_use_id: call.toolUseId,
              name: call.name,
              recovered: true,
              ...(result.ok ? {} : { error: result.text }),
            },
            blocks: [
              {
                type: "tool_result",
                tool_use_id: call.toolUseId,
                content: [{ type: "text", text: result.text }],
                is_error: !result.ok,
              },
            ],
            on_surface: 1,
          },
        },
        checkpoint.positionWrite(runId, position),
      ],
    });
  }

  // Every call now has an outcome, so the loop can assemble the tool-result message.
  checkpoint.write(store, runId, { phase: "checkpoint" });

  const synthesized = plan.synthesize.length;
  events.push(
    recoveryEvent(runId, fromPhase, synthesized > 0 ? "abandoned" : "replayed", false, ts),
  );

  return {
    plan,
    fromPhase,
    action: synthesized > 0 ? "abandoned" : "replayed",
    uncertain: false,
    synthesized,
    reexecuted,
    events,
    terminal: false,
  };
}

function recoveryEvent(
  runId: string,
  fromPhase: string,
  action: RecoveryAppliedPayload["action"],
  uncertain: boolean,
  ts: number,
): EventEnvelope {
  return {
    id: null,
    session_id: "",
    ai_run_id: runId,
    seq: null,
    type: "recovery_applied",
    actor: { kind: "system" },
    ts: new Date(ts).toISOString(),
    payload: { run_id: runId, from_phase: fromPhase, action, uncertain },
  };
}

function outcome(
  plan: Recovery,
  fromPhase: string,
  action: RecoveryAppliedPayload["action"],
  uncertain: boolean,
  synthesized: number,
  reexecuted: number,
  extra: EventEnvelope[],
  terminal: boolean,
  runId: string,
  deps: RecoveryDeps,
): RecoveryOutcome {
  return {
    plan,
    fromPhase,
    action,
    uncertain,
    synthesized,
    reexecuted,
    events: [...extra, recoveryEvent(runId, fromPhase, action, uncertain, deps.now())],
    terminal,
  };
}

/** Recover every run this session's store still holds a live position for. */
export async function recoverSession(
  store: HarnessStoreApi,
  deps: RecoveryDeps,
): Promise<RecoveryOutcome[]> {
  const results: RecoveryOutcome[] = [];
  for (const runId of store.activeRunIds()) {
    results.push(await applyRecovery(store, runId, deps));
  }
  return results;
}

export type { Position };
