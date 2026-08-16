// The two-tier event store (web-event-transport). Durable events are keyed and
// deduped by the global `id`; ephemeral events (null `id`) are NEVER stored in
// the durable map and NEVER deduped by `id` — `ai_text_delta` accumulates into
// in-progress text keyed by `(ai_run_id, block)`, `presence_changed` is
// last-writer-wins per participant. Selectors keep a delta flood from
// re-rendering the durable log. Mirrors the frozen event-envelope two-tier rule.

import type { EventEnvelope } from "@clawdparty/contracts";
import { create } from "zustand";

// `block` is treated as an opaque accumulation key (resolved to
// "<message_uuid>:<block_index>" at contract v1.1, but the store does not parse it).
function deltaKey(aiRunId: string | null, block: string): string {
  return `${aiRunId ?? "?"}::${block}`;
}

interface DeltaPayload {
  block?: string;
  text?: string;
}
interface PresencePayload {
  participant_id?: string;
  online?: boolean;
}

type LiveFields = Pick<
  EventStoreState,
  "textByBlock" | "thinkingByBlock" | "settledBlocks" | "terminatedRuns"
>;

// When a durable block settles (ai_text/ai_thinking), drop its live accumulator so
// the block is not rendered twice (live + durable), and REMEMBER that it settled so a
// late delta cannot re-create it. Deltas and durable events travel over two independent
// channels — deltas are coalesced into a ~150ms window in the harness while durable
// batches POST immediately — so `ai_text` routinely lands before the tail of its own
// delta stream. Deleting the accumulator without remembering left the late delta free to
// rebuild it, and `activity_feed.tsx` renders every accumulator: the paragraph appeared
// twice, once settled and once as a fragment below it.
//
// On a terminal run event, sweep every live block for that run as a safety net (in case
// a block event was missed) and forget its settled keys, which is what bounds the set.
function reconcileLive(state: EventStoreState, event: EventEnvelope): Partial<LiveFields> {
  if (event.type === "ai_text" || event.type === "ai_thinking") {
    const key = deltaKey(event.ai_run_id, (event.payload as DeltaPayload).block ?? "");
    const field = event.type === "ai_text" ? "textByBlock" : "thinkingByBlock";
    const settledBlocks = new Set(state.settledBlocks).add(settledKey(field, key));
    if (!state[field].has(key)) {
      return { settledBlocks };
    }
    const next = new Map(state[field]);
    next.delete(key);
    return { [field]: next, settledBlocks };
  }
  if (TERMINAL_RUN_TYPES.has(event.type) && event.ai_run_id) {
    const prefix = `${event.ai_run_id}::`;
    return {
      textByBlock: withoutPrefix(state.textByBlock, prefix),
      thinkingByBlock: withoutPrefix(state.thinkingByBlock, prefix),
      // The run is RECORDED as over, rather than its settled keys being forgotten.
      //
      // Forgetting them bounded the set but opened the exact hole the set closes: ephemerals are
      // delayed ~150ms while durables POST immediately, so the true order is `ai_text` ->
      // `run_finished` -> the block's last deltas. With the keys dropped, that straggler
      // re-created the accumulator, and the feed renders every accumulator — the answer appeared
      // twice, the second copy with a live cursor, until a refresh (which backfills durables
      // only). One entry per RUN is a tighter bound than one per block anyway, and it also covers
      // a run that failed mid-block, where no `ai_text` ever settled anything.
      terminatedRuns: new Set(state.terminatedRuns).add(event.ai_run_id),
    };
  }
  return {};
}

/** Namespaced so a text block and a thinking block of the same name settle independently. */
function settledKey(field: "textByBlock" | "thinkingByBlock", key: string): string {
  return `${field === "textByBlock" ? "t" : "k"}:${key}`;
}

function withoutPrefix(map: Map<string, string>, prefix: string): Map<string, string> {
  const next = new Map(map);
  for (const key of next.keys()) {
    if (key.startsWith(prefix)) {
      next.delete(key);
    }
  }
  return next;
}

export interface EventStoreState {
  // Durable events deduped by id, in insertion (ascending-id) order. `durableList`
  // is the referentially-STABLE array selectors return — its identity changes only
  // when a durable event is actually appended, so `useEventStore(selectDurableEvents)`
  // does not loop. `seenIds` is the O(1) dedupe set.
  durableList: EventEnvelope[];
  seenIds: Set<number>;
  // In-progress streamed text, keyed by (ai_run_id, block).
  textByBlock: Map<string, string>;
  // In-progress streamed thinking, keyed by (ai_run_id, block).
  thinkingByBlock: Map<string, string>;
  // Blocks whose durable ai_text/ai_thinking has already been applied — deltas for these
  // are ignored.
  settledBlocks: Set<string>;
  /** Runs that have reached a terminal event. A delta arriving for one is stale by definition. */
  terminatedRuns: Set<string>;
  // Presence, last-writer-wins per participant id.
  presenceByParticipant: Map<string, boolean>;
  // The catch-up / reconnect cursor: the max applied durable id (0 if none).
  maxAppliedId: number;
  /**
   * A run was SUBMITTED but has emitted nothing yet.
   *
   * UI state, set explicitly rather than derived, because there is no event to derive it from:
   * between a successful POST and the harness's first `run_started` the event stream is silent,
   * and the feed showed no activity at all — which read as "it is not even processing".
   */
  runPending: boolean;

  apply: (event: EventEnvelope) => void;
  applyMany: (events: EventEnvelope[]) => void;
  markRunPending: () => void;
  clearRunPending: () => void;
  reset: () => void;
}

export const useEventStore = create<EventStoreState>((set, get) => ({
  durableList: [],
  seenIds: new Set(),
  textByBlock: new Map(),
  thinkingByBlock: new Map(),
  settledBlocks: new Set(),
  terminatedRuns: new Set(),
  presenceByParticipant: new Map(),
  maxAppliedId: 0,
  runPending: false,

  apply: (event) => {
    // Ephemeral: null id. Never deduped by id, never in the durable list.
    if (event.id === null) {
      if (event.type === "ai_text_delta" || event.type === "ai_thinking_delta") {
        const payload = (event.payload ?? {}) as DeltaPayload;
        const key = deltaKey(event.ai_run_id, payload.block ?? "");
        const field = event.type === "ai_text_delta" ? "textByBlock" : "thinkingByBlock";
        // Stale if the block already settled, OR if the whole run is over — the second case is
        // what a delayed delta after `run_finished` actually is.
        if (
          get().settledBlocks.has(settledKey(field, key)) ||
          (event.ai_run_id !== null && get().terminatedRuns.has(event.ai_run_id))
        ) {
          return;
        }
        const next = new Map(get()[field]);
        next.set(key, (next.get(key) ?? "") + (payload.text ?? ""));
        set({ [field]: next } as Pick<EventStoreState, "textByBlock" | "thinkingByBlock">);
        return;
      }
      if (event.type === "presence_changed") {
        const payload = (event.payload ?? {}) as PresencePayload;
        if (payload.participant_id !== undefined) {
          const next = new Map(get().presenceByParticipant);
          next.set(payload.participant_id, payload.online ?? false);
          set({ presenceByParticipant: next });
        }
        return;
      }
      // Any other null-id event is ephemeral-by-envelope; apply nothing durable.
      return;
    }

    // Durable: dedupe by id (idempotent across backfill + live).
    if (get().seenIds.has(event.id)) {
      return;
    }
    set((state) => {
      const seenIds = new Set(state.seenIds);
      seenIds.add(event.id as number);
      return {
        // The harness is emitting now, so the optimistic flag is redundant. Clearing it here
        // rather than only on run_started means a run that fails before starting still settles.
        runPending: event.ai_run_id === null ? state.runPending : false,
        // New array identity ONLY on a real append (stable across no-op re-applies).
        durableList: [...state.durableList, event],
        seenIds,
        maxAppliedId: Math.max(state.maxAppliedId, event.id as number),
        // Reconcile: a settled block supersedes its live accumulator (avoid showing
        // it twice — once live, once durable). Clear per-block for ai_text/ai_thinking.
        ...reconcileLive(state, event),
      };
    });
  },

  applyMany: (events) => {
    for (const event of events) {
      get().apply(event);
    }
  },

  markRunPending: () => set({ runPending: true }),
  // Explicit, because a REFUSED submit emits no event and nothing else would ever clear it.
  clearRunPending: () => set({ runPending: false }),

  reset: () =>
    set({
      durableList: [],
      seenIds: new Set(),
      textByBlock: new Map(),
      thinkingByBlock: new Map(),
      settledBlocks: new Set(),
      terminatedRuns: new Set(),
      presenceByParticipant: new Map(),
      maxAppliedId: 0,
      runPending: false,
    }),
}));

// --- Selectors (subscribe narrowly so a delta does not re-render the log). ---

// Returns the STABLE durable array (same reference until a durable event is
// appended), so consuming it via useEventStore() does not cause a render loop.
export function selectDurableEvents(state: EventStoreState): EventEnvelope[] {
  return state.durableList;
}

export function selectBlockText(aiRunId: string | null, block: string) {
  return (state: EventStoreState): string => state.textByBlock.get(deltaKey(aiRunId, block)) ?? "";
}

export function selectMaxAppliedId(state: EventStoreState): number {
  return state.maxAppliedId;
}

// The active run id, derived from lifecycle events: a run_started whose ai_run_id
// has no terminal lifecycle event yet. Returns null if no run is active. Used to
// gate the composer (start vs follow-up) and the interrupt button — status comes
// from events, never a bespoke message.
const TERMINAL_RUN_TYPES = new Set(["run_finished", "run_failed", "run_interrupted"]);

export function selectActiveRunId(state: EventStoreState): string | null {
  const terminated = new Set<string>();
  const started = new Set<string>();
  for (const e of state.durableList) {
    if (e.ai_run_id === null) {
      continue;
    }
    if (e.type === "run_started") {
      started.add(e.ai_run_id);
    } else if (TERMINAL_RUN_TYPES.has(e.type)) {
      terminated.add(e.ai_run_id);
    }
  }
  for (const runId of started) {
    if (!terminated.has(runId)) {
      return runId;
    }
  }
  return null;
}

// The run currently awaiting review, derived from changeset lifecycle events: the
// most recently started run whose latest changeset event is `changeset_ready`
// (with no later `changeset_approved`/`changeset_rejected`). Returns null when no
// such run exists — e.g. after approve/reject, or once a revise starts a new run.
// Gates the diff viewer and the composer's revise mode; status comes from events.
export function selectAwaitingReviewRunId(state: EventStoreState): string | null {
  let currentRun: string | null = null;
  for (const e of state.durableList) {
    if (e.type === "run_started" && e.ai_run_id !== null) {
      currentRun = e.ai_run_id;
    }
  }
  if (currentRun === null) {
    return null;
  }
  let awaiting = false;
  for (const e of state.durableList) {
    if (e.ai_run_id !== currentRun) {
      continue;
    }
    if (e.type === "changeset_ready") {
      awaiting = true;
    } else if (e.type === "changeset_approved" || e.type === "changeset_rejected") {
      awaiting = false;
    }
  }
  return awaiting ? currentRun : null;
}

/**
 * Paths the CURRENT run reported changing, de-duplicated, in first-touch order.
 *
 * A chat run has no worktree and no changeset, so `GET /api/runs/:id/diff` has nothing to
 * describe — these events are the only record of what was touched, and without them a
 * participant who watched Claude edit files has no way to see which ones.
 *
 * Returns a NEW array each call, so subscribe to the stable `durableList` and derive from
 * it — passing this straight to `useEventStore` would re-render forever. The parameter is
 * narrowed to the one field it reads so callers can hand it that slice.
 */
export function selectChangedPaths(state: Pick<EventStoreState, "durableList">): string[] {
  let currentRun: string | null = null;
  for (const e of state.durableList) {
    if (e.type === "run_started" && e.ai_run_id !== null) {
      currentRun = e.ai_run_id;
    }
  }
  if (currentRun === null) {
    return [];
  }
  const seen = new Set<string>();
  for (const e of state.durableList) {
    if (e.ai_run_id !== currentRun || e.type !== "file_changed") {
      continue;
    }
    const path = (e.payload as { path?: string }).path;
    if (path) {
      seen.add(path);
    }
  }
  return [...seen];
}

export interface ContextUsage {
  // Prompt-side tokens of the most recent completed run — a proxy for how full the
  // context window is (input + cache-read + cache-creation = everything sent that turn).
  contextTokens: number;
  // The model that run used (from its run_started), for mapping to a window size.
  model: string | null;
}

// The latest completed run's token usage, an approximate "context filled" gauge.
// `usage` rides run_finished/run_failed (harness-populated) and lands in durableList.
// Returns null before any run completes. NOTE: the SDK only reports usage on the
// result message, so this reflects the LAST COMPLETED run — it updates at run end,
// not live mid-stream. run_interrupted carries no usage and is ignored here.
export function selectLatestUsage(state: EventStoreState): ContextUsage | null {
  let terminal: EventEnvelope | null = null;
  for (const e of state.durableList) {
    if (e.ai_run_id !== null && (e.type === "run_finished" || e.type === "run_failed")) {
      terminal = e;
    }
  }
  if (terminal === null) {
    return null;
  }
  const usage = (terminal.payload as { usage?: Record<string, number> }).usage;
  if (!usage) {
    return null;
  }
  const contextTokens =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0);
  let model: string | null = null;
  for (const e of state.durableList) {
    if (e.type === "run_started" && e.ai_run_id === terminal.ai_run_id) {
      model = (e.payload as { model?: string }).model ?? null;
    }
  }
  return { contextTokens, model };
}

export { deltaKey };
