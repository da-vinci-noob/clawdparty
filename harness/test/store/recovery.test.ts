import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as checkpoint from "../../src/loop/checkpoint.js";
import { applyRecovery, recoverSession } from "../../src/store/recovery.js";
import { openStore } from "../../src/store/store.js";
import type { HarnessStoreApi, Position } from "../../src/store/types.js";
import { Supervisor } from "../../src/supervisor.js";
import { Transport } from "../../src/transport.js";

/**
 * a crash never strands a session, and recovery STATES what it did.
 *
 * Every case here is one row of the recovery decision table, driven through a real store. The pure
 * decision is covered elsewhere; this asserts the EXECUTION: what gets written, under which
 * reserved id, and whether the outcome is honestly reported as uncertain.
 */

const RUN = "run_1";
let dir: string;
let store: HarnessStoreApi;
const deps = { now: () => 1_700_000_000_000 };

async function open(): Promise<HarnessStoreApi> {
  const result = await openStore("session_1", { dir });
  if (!result.ok) throw new Error(`store did not open: ${result.reason}`);
  return result.store;
}

function seed(position: Position): void {
  checkpoint.write(store, RUN, position);
}

function entriesFor(runId: string) {
  return store.entriesFrom(0).filter((e) => e.run_id === runId);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "harness-recovery-"));
  store = await open();
});
afterEach(() => {
  store.close?.();
  rmSync(dir, { recursive: true, force: true });
});

describe("checkpoint — resume normally", () => {
  it("writes nothing and reports resumed", async () => {
    seed({ phase: "checkpoint" });

    const result = await applyRecovery(store, RUN, deps);

    expect(result.action).toBe("resumed");
    expect(result.uncertain).toBe(false);
    expect(entriesFor(RUN)).toHaveLength(0);
    expect(result.terminal).toBe(false);
  });
});

describe("request_pending — the only permitted uncertainty", () => {
  beforeEach(() => {
    seed({
      phase: "request_pending",
      settlementKey: "settle_7",
      reservedUsageId: 3,
      requestSnapshotId: "snap_1",
      attempt: 1,
      maxAttempts: 3,
      notBeforeMs: 0,
    });
  });

  it("settles as interrupted and reports uncertain, never success or failure", async () => {
    const result = await applyRecovery(store, RUN, deps);

    // The load-bearing assertion of the whole feature. The request may have been
    // billed and may have produced output nobody recorded; asserting either would put
    // a claim in the record the harness cannot support.
    expect(result.uncertain).toBe(true);
    expect(result.action).toBe("abandoned");
  });

  it("writes the settlement under its SETTLEMENT KEY, with NO event seq", async () => {
    await applyRecovery(store, RUN, deps);

    const entry = entriesFor(RUN).at(0);
    // The key carries the identity. The seq is NULL because this is a store entry, not an
    // emitted event — consuming a seq here punched a hole in the emitted per-run sequence,
    // which the frozen envelope rules forbid. Reserving a seq (the original design) was
    // worse still: it collided with the turn's own entries, so UNIQUE (run_id, seq) rejected
    // the settlement and the constraint meant to stop a SECOND one blocked the FIRST.
    expect(entry?.settlement_key).toBe("settle_7");
    expect(entry?.seq).toBeNull();
    expect(entry?.type).toBe("run_interrupted");
    expect(entry?.payload).toMatchObject({ uncertain: true, reason: "harness_restart" });
  });

  it("keeps the uncertain turn OFF the surface", async () => {
    await applyRecovery(store, RUN, deps);

    // On the surface it would be replayed to the model as a real assistant turn — a
    // turn whose content nobody knows. The next request must fold from before it.
    expect(entriesFor(RUN).at(0)?.on_surface).toBe(0);
  });

  it("leaves the run terminal so Rails is told", async () => {
    const result = await applyRecovery(store, RUN, deps);

    expect(result.terminal).toBe(true);
    expect(checkpoint.read(store, RUN)).toEqual({ phase: "terminal", outcome: "interrupted" });
  });

  it("is itself recoverable — a crash DURING recovery does not double-settle", async () => {
    await applyRecovery(store, RUN, deps);
    // Simulate dying after the settlement but before anything downstream, then
    // recovering again from the SAME position.
    seed({
      phase: "request_pending",
      settlementKey: "settle_7",
      reservedUsageId: 3,
      requestSnapshotId: "snap_1",
      attempt: 1,
      maxAttempts: 3,
      notBeforeMs: 0,
    });

    await applyRecovery(store, RUN, deps);

    // UNIQUE (run_id, settlement_key) rejects the second settlement, so the transcript
    // gains no duplicate — enforced by the schema rather than by remembering to check
    // (invariant 7). Note the seq differs on the second attempt; the KEY is what makes
    // it single-use, which is exactly why the identity moved off the seq.
    expect(entriesFor(RUN).filter((e) => e.settlement_key === "settle_7")).toHaveLength(1);
  });
});

describe("tools — replay policy decides per call", () => {
  function toolsPosition(
    calls: Array<{
      name: string;
      replay: "safe" | "never";
      status: "planned" | "effect_pending" | "completed";
    }>,
  ): Position {
    return {
      phase: "tools",
      stepId: `${RUN}:10`,
      calls: calls.map((c, index) => ({
        index,
        toolUseId: `tu_${index}`,
        name: c.name,
        settlementKey: `tu_${index}`,
        replay: c.replay,
        status: c.status,
      })),
    };
  }

  it("does NOT re-execute a `never` call, and still gives it an outcome", async () => {
    seed(toolsPosition([{ name: "bash", replay: "never", status: "effect_pending" }]));
    const reexecute = vi.fn();

    const result = await applyRecovery(store, RUN, { ...deps, reexecute });

    // The asymmetry that matters: a bash command may already have pushed a commit, so
    // re-running is the one thing that must not happen — but a tool_use with no
    // tool_result is a conversation the model cannot reason about.
    expect(reexecute).not.toHaveBeenCalled();
    expect(result.synthesized).toBe(1);
    expect(result.reexecuted).toBe(0);
  });

  it("puts the synthetic result ON the surface so the model sees an answer", async () => {
    seed(toolsPosition([{ name: "bash", replay: "never", status: "effect_pending" }]));

    await applyRecovery(store, RUN, deps);

    const entry = entriesFor(RUN).at(0);
    expect(entry?.settlement_key).toBe("tu_0");
    expect(entry?.on_surface).toBe(1);
    // A provider rejects a request whose tool_use has no matching tool_result, so
    // "off the surface" here would break the very next request.
    expect(JSON.stringify(entry?.blocks)).toContain("tool_result");
    expect(JSON.stringify(entry?.blocks)).toContain("tu_0");
  });

  it("does not spend an event seq on the synthetic result", async () => {
    seed(toolsPosition([{ name: "bash", replay: "never", status: "effect_pending" }]));

    const result = await applyRecovery(store, RUN, deps);

    // The synthesized settlement is store-only — surface state for the next request, never
    // an event. It was a hand-copied `resultWrite` that kept its `allocateSeq` when that
    // function moved to `seq: null`, so it took an id out of the emitted stream and left a
    // gap where a client sees a dropped event. The re-executed path never had this because
    // it calls the shared function.
    const settlement = entriesFor(RUN).find((e) => e.settlement_key === "tu_0");
    expect(settlement?.seq).toBeNull();
    expect(settlement?.emitted).toBe(0);

    // `recovery_applied` IS emitted, so it takes the run's first seq. If the settlement had
    // consumed one, this would be 2.
    expect(result.events.map((e) => e.seq)).toEqual([1]);
  });

  it("RE-EXECUTES a `safe` call using args from the record, not memory", async () => {
    const position = toolsPosition([{ name: "read", replay: "safe", status: "effect_pending" }]);
    seed(position);
    // Args were persisted at clearance; memory is what the crash destroyed.
    store.commit({
      writes: [
        {
          kind: "register",
          op: "set",
          namespace: "run.tool_args",
          key: `${RUN}:10:0`,
          value: { path: "src/app.ts" },
        },
      ],
    });
    const reexecute = vi.fn().mockResolvedValue({ ok: true, text: "file contents" });

    const result = await applyRecovery(store, RUN, { ...deps, reexecute });

    expect(reexecute).toHaveBeenCalledTimes(1);
    expect(reexecute.mock.calls[0]?.[1]).toEqual({ path: "src/app.ts" });
    expect(result.reexecuted).toBe(1);
    expect(entriesFor(RUN).at(0)?.type).toBe("tool_finished");
  });

  it("handles a MIXED turn: synthesizes the never call and re-runs the safe one", async () => {
    seed(
      toolsPosition([
        { name: "bash", replay: "never", status: "effect_pending" },
        { name: "grep", replay: "safe", status: "effect_pending" },
      ]),
    );
    const reexecute = vi.fn().mockResolvedValue({ ok: true, text: "match" });

    const result = await applyRecovery(store, RUN, { ...deps, reexecute });

    // Per-CALL, not per-turn. A turn-level decision would either re-run bash or
    // abandon a pure read for no reason.
    expect(result.synthesized).toBe(1);
    expect(result.reexecuted).toBe(1);
    expect(reexecute.mock.calls[0]?.[0]?.name).toBe("grep");
  });

  it("gives each call a DISTINCT settlement key, so both can settle", async () => {
    seed(
      toolsPosition([
        { name: "bash", replay: "never", status: "effect_pending" },
        { name: "sh", replay: "never", status: "effect_pending" },
      ]),
    );

    const result = await applyRecovery(store, RUN, deps);

    // One shared key would make the SECOND settlement a duplicate of the first, so one
    // call would silently go unanswered — the same class of failure the reserved-seq
    // collision produced, arriving from the other direction.
    expect(result.synthesized).toBe(2);
    const keys = entriesFor(RUN).map((e) => e.settlement_key);
    expect(new Set(keys).size).toBe(2);
  });

  it("EXECUTES a `planned` call, which never started, and answers it", async () => {
    seed(toolsPosition([{ name: "bash", replay: "never", status: "planned" }]));
    const reexecute = vi.fn().mockResolvedValue({ ok: true, text: "ran now" });

    const result = await applyRecovery(store, RUN, { ...deps, reexecute });

    // `planned` means the effect never happened, so this is a FIRST execution and safe
    // even for `never`. The recovery decision table omitted this status, so these
    // calls used to be dropped with no tool_result at all — which a provider rejects.
    expect(result.executed).toBe(1);
    expect(result.reexecuted).toBe(0);
    expect(reexecute).toHaveBeenCalledTimes(1);
    expect(entriesFor(RUN).at(0)?.on_surface).toBe(1);
  });

  it("leaves the position at checkpoint so the loop can assemble the results", async () => {
    seed(toolsPosition([{ name: "bash", replay: "never", status: "effect_pending" }]));

    await applyRecovery(store, RUN, deps);

    expect(checkpoint.read(store, RUN)).toEqual({ phase: "checkpoint" });
  });

  it("writes nothing when every call already completed", async () => {
    seed(toolsPosition([{ name: "bash", replay: "never", status: "completed" }]));

    const result = await applyRecovery(store, RUN, deps);

    expect(result.synthesized).toBe(0);
    expect(entriesFor(RUN)).toHaveLength(0);
  });

  it("marks every settled call completed, so a second pass is a no-op", async () => {
    seed(toolsPosition([{ name: "bash", replay: "never", status: "effect_pending" }]));
    await applyRecovery(store, RUN, deps);

    // Recovery is idempotent by construction: the first pass advanced the call, so the
    // position no longer describes pending work.
    const second = await applyRecovery(store, RUN, deps);
    expect(second.action).toBe("resumed");
    expect(entriesFor(RUN)).toHaveLength(1);
  });
});

describe("planTools derives the settlement identity", () => {
  it("uses each call's tool_use_id, so keys are distinct by construction", () => {
    const position = checkpoint.planTools("step_1", [
      { toolUseId: "tu_a", name: "bash", replay: "never" },
      { toolUseId: "tu_b", name: "sh", replay: "never" },
    ]);

    // Tested through planTools, not by hand-building a position: a shared key would make
    // the second settlement a duplicate of the first and one call would go unanswered,
    // and a test that constructs its own keys cannot see that.
    expect(position.calls.map((c) => c.settlementKey)).toEqual(["tu_a", "tu_b"]);
    expect(new Set(position.calls.map((c) => c.settlementKey)).size).toBe(2);
  });

  it("reserves no seq at all, which is what removed the collision", () => {
    const position = checkpoint.planTools("step_1", [
      { toolUseId: "tu_a", name: "bash", replay: "never" },
    ]);

    // The identity must not be a seq. Reserving one handed out ids the turn's own entries
    // were about to use, so UNIQUE (run_id, seq) rejected the settlement.
    expect(position.calls[0]).not.toHaveProperty("reservedEntrySeq");
  });
});

describe("the remaining rows", () => {
  it("compacting re-runs compaction, which is deterministic", async () => {
    seed({ phase: "compacting", preparationId: "prep_1" });

    const result = await applyRecovery(store, RUN, deps);

    expect(result.action).toBe("replayed");
    expect(checkpoint.read(store, RUN)).toEqual({ phase: "checkpoint" });
  });

  it("terminal owes nothing but is still reported", async () => {
    seed({ phase: "terminal", outcome: "finished" });

    const result = await applyRecovery(store, RUN, deps);

    // Rails may be behind even when the harness is done, so "nothing owed" must not
    // mean "say nothing" — that is how a run stays active in the projection forever.
    expect(result.terminal).toBe(true);
    expect(entriesFor(RUN)).toHaveLength(0);
  });

  it("an ABSENT position reports failed rather than inventing a state", async () => {
    const result = await applyRecovery(store, "never_started", deps);

    expect(result.action).toBe("failed");
    expect(result.fromPhase).toBe("absent");
    expect(result.terminal).toBe(true);
  });
});

describe("recovery_applied says what happened", () => {
  it("is emitted for every recovered run", async () => {
    seed({ phase: "checkpoint" });

    const result = await applyRecovery(store, RUN, deps);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.type).toBe("recovery_applied");
  });

  it("carries the frozen payload shape, with from_phase and uncertain", async () => {
    seed({
      phase: "request_pending",
      settlementKey: "settle_7",
      reservedUsageId: 3,
      requestSnapshotId: "s",
      attempt: 1,
      maxAttempts: 3,
      notBeforeMs: 0,
    });

    const result = await applyRecovery(store, RUN, deps);

    expect(result.events[0]?.payload).toEqual({
      run_id: RUN,
      from_phase: "request_pending",
      action: "abandoned",
      uncertain: true,
    });
  });

  it("reports the phase it recovered FROM, not the one it moved to", async () => {
    seed({ phase: "compacting", preparationId: "p" });

    const result = await applyRecovery(store, RUN, deps);

    // Reporting the destination would make every row read "checkpoint" and the feed
    // would never explain what was interrupted.
    expect(result.events[0]?.payload).toMatchObject({ from_phase: "compacting" });
  });
});

describe("session-wide recovery on boot", () => {
  it("recovers every run the store still holds a position for", async () => {
    checkpoint.write(store, "run_a", { phase: "checkpoint" });
    checkpoint.write(store, "run_b", {
      phase: "request_pending",
      settlementKey: "settle_1",
      reservedUsageId: 1,
      requestSnapshotId: "s",
      attempt: 1,
      maxAttempts: 3,
      notBeforeMs: 0,
    });

    const results = await recoverSession(store, deps);

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.uncertain).sort()).toEqual([false, true]);
  });

  it("does nothing on a store with no live runs", async () => {
    expect(await recoverSession(store, deps)).toEqual([]);
  });

  it("recovers BEFORE serving, via Supervisor.recoverAll", async () => {
    checkpoint.write(store, "run_c", {
      phase: "request_pending",
      settlementKey: "settle_5",
      reservedUsageId: 1,
      requestSnapshotId: "s",
      attempt: 1,
      maxAttempts: 3,
      notBeforeMs: 0,
    });
    await store.close();

    const shipped: unknown[] = [];
    const transport = new Transport({
      railsInternalUrl: "http://rails:3000",
      sharedSecret: "s",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      fetchImpl: async (_url, init) => {
        shipped.push(JSON.parse(String((init as { body?: unknown }).body)));
        return new Response("{}", { status: 200 });
      },
    });
    const supervisor = new Supervisor(transport, { storeDir: dir });

    const results = await supervisor.recoverAll();

    // Discovered from the filesystem: stores are session-<id>.sqlite3, so there is no
    // separate registry that could disagree with what is on disk.
    expect(results).toHaveLength(1);
    expect(results[0]?.sessionId).toBe("session_1");
    expect(results[0]?.outcome.uncertain).toBe(true);
    await supervisor.shutdown();

    // recovery.ts does not know the session id; the supervisor stamps it, or the
    // envelope would be unroutable and Rails would never learn a run was recovered.
    await transport.flush();
    expect(JSON.stringify(shipped)).toContain("session_1");
    expect(JSON.stringify(shipped)).toContain("recovery_applied");

    // `store_seq` NULL, because no entry backs this event — `recovery_applied` is emitted, never
    // written to the log. Stamping it with the high-water mark instead made a HEALTHY recovered
    // session report `diverged: true, reason: unexpected_rows`: the mark belonged to the synthesized
    // `tool_failed` entry, which is store-only and therefore absent from the record's projection, so
    // Rails held a position the record's projection did not. Measured on live session 145 —
    // `rails: [24, 19]` against `harness: [23, 18]`. It would also lose the event on a
    // `rederive(reset:)`, which deletes rows WITH a `store_seq` and could not rebuild this one.
    const recovery = shipped
      .flatMap((batch) => (batch as { events?: Array<Record<string, unknown>> }).events ?? [])
      .filter((event) => event.type === "recovery_applied");
    expect(recovery).not.toHaveLength(0);
    for (const event of recovery) expect(event.store_seq).toBeUndefined();

    store = await open();
  });

  it("SKIPS a store held by another live harness rather than stealing it", async () => {
    // The lock means another process owns that record. Two writers on one run is worse
    // than a delayed recovery, and the incumbent will recover it itself.
    const transport = new Transport({
      railsInternalUrl: "http://rails:3000",
      sharedSecret: "s",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    const supervisor = new Supervisor(transport, { storeDir: dir });

    // `store` from beforeEach still holds the lock.
    const results = await supervisor.recoverAll();

    expect(results).toEqual([]);
    await supervisor.shutdown();
  });
});
