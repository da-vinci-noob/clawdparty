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

export interface EventStoreState {
  // Durable events deduped by id, in insertion (ascending-id) order. `durableList`
  // is the referentially-STABLE array selectors return — its identity changes only
  // when a durable event is actually appended, so `useEventStore(selectDurableEvents)`
  // does not loop. `seenIds` is the O(1) dedupe set.
  durableList: EventEnvelope[];
  seenIds: Set<number>;
  // In-progress streamed text, keyed by (ai_run_id, block).
  textByBlock: Map<string, string>;
  // Presence, last-writer-wins per participant id.
  presenceByParticipant: Map<string, boolean>;
  // The catch-up / reconnect cursor: the max applied durable id (0 if none).
  maxAppliedId: number;

  apply: (event: EventEnvelope) => void;
  applyMany: (events: EventEnvelope[]) => void;
  reset: () => void;
}

export const useEventStore = create<EventStoreState>((set, get) => ({
  durableList: [],
  seenIds: new Set(),
  textByBlock: new Map(),
  presenceByParticipant: new Map(),
  maxAppliedId: 0,

  apply: (event) => {
    // Ephemeral: null id. Never deduped by id, never in the durable list.
    if (event.id === null) {
      if (event.type === "ai_text_delta") {
        const payload = (event.payload ?? {}) as DeltaPayload;
        const key = deltaKey(event.ai_run_id, payload.block ?? "");
        const next = new Map(get().textByBlock);
        next.set(key, (next.get(key) ?? "") + (payload.text ?? ""));
        set({ textByBlock: next });
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
        // New array identity ONLY on a real append (stable across no-op re-applies).
        durableList: [...state.durableList, event],
        seenIds,
        maxAppliedId: Math.max(state.maxAppliedId, event.id as number),
      };
    });
  },

  applyMany: (events) => {
    for (const event of events) {
      get().apply(event);
    }
  },

  reset: () =>
    set({
      durableList: [],
      seenIds: new Set(),
      textByBlock: new Map(),
      presenceByParticipant: new Map(),
      maxAppliedId: 0,
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

export { deltaKey };
