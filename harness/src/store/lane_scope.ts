import type { LoopStore, Transaction } from "./types.js";

/**
 * A lane-scoped VIEW of a session's store.
 *
 * One store serves every lane in a session (refcounted by the supervisor), so the lane cannot live
 * on the store itself. It has to arrive with each commit — and there are eleven commit sites
 * between `run_loop.ts` and `checkpoint.ts`, so threading it through each one by hand is a design
 * where forgetting one is both easy and silent: the lane's leaf would simply stop advancing, and
 * nothing would fail until a second lane resumed from a stale position.
 *
 * So the lane is applied in exactly ONE place. Every commit made through this view carries it, and
 * no call site can omit it because no call site knows about it.
 *
 * An EXPLICIT `lane` on a transaction still wins. Recovery and session-level bookkeeping write
 * things that are not lane-scoped at all, and a wrapper that overwrote their (absent) lane would
 * attribute session state to whichever lane happened to be running.
 */
export function laneScoped(store: LoopStore, lane: string): LoopStore {
  // A PROTOTYPE-preserving delegate: `Object.create(store)` keeps every method the store has,
  // including the ones on its class prototype, and only `commit` is overridden. A spread
  // (`{ ...store }`) copies own properties only, so it would silently drop every prototype method
  // and the loop would fail on whichever one it reached first.
  const view: LoopStore = Object.create(store);
  view.commit = (tx: Transaction) => store.commit(tx.lane === undefined ? { ...tx, lane } : tx);
  return view;
}

/**
 * Claim the lane for a run, or release it.
 *
 * `lane.state` answers "who owns this lane right now", which is what makes a second start in the
 * same lane refusable from the RECORD rather than only from process memory — the supervisor's
 * in-memory map is lost on a crash, and the register is not.
 *
 * `pendingNext` is reserved for the queue-behind case and stays null until something needs it;
 * writing a value nothing reads is the defect this session kept finding.
 */
export function claimLane(store: LoopStore, lane: string, runId: string | null): void {
  store.commit({
    writes: [
      {
        kind: "register",
        op: "set",
        namespace: "lane.state",
        key: lane,
        value: { currentRunId: runId, pendingNext: null },
      },
    ],
  });
}
