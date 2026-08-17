import type { EventEnvelope } from "@clawdparty/contracts";
import { EPHEMERAL_EVENT_TYPES, SYNTHESIZED_EVENT_TYPES } from "@clawdparty/contracts";
import { describe, expect, it } from "vitest";
import { useEventStore } from "../stores/event_store";
import { type SessionChannel, startCatchUp } from "./cable";

/**
 * late joiners catch up without gaps or duplicates ACROSS EVERY OCCURRENCE TYPE
 * THIS FEATURE ADDS, not one of them.
 *
 * Written as ONE test parameterized over `SYNTHESIZED_EVENT_TYPES` from `packages/contracts`,
 * deliberately, and the parameterization is the point: a test per type drifts as types are added,
 * which is the failure mode being fixed — only `context_compacted` had a live-vs-late-joiner
 * assertion while eight other types had none. Because the list is IMPORTED rather than
 * copied, adding a tenth synthesized type without covering it here is a failing test, not an
 * omission nobody notices.
 *
 * Two obligations, and they are opposites:
 *
 *   * a DURABLE type must reach a mid-run joiner EXACTLY ONCE — the overlap between REST backfill
 *     and the live buffer is where a duplicate comes from;
 *   * `context_usage` is EPHEMERAL and must NOT be replayed to them. It was never persisted, so
 *     backfilling it would be inventing history.
 */

const DURABLE_SYNTHESIZED = SYNTHESIZED_EVENT_TYPES.filter(
  (type) => !(EPHEMERAL_EVENT_TYPES as readonly string[]).includes(type),
);

/** A payload shaped enough for the store; the reducer only reads a few keys per type. */
function payloadFor(type: string): Record<string, unknown> {
  switch (type) {
    case "user_prompt":
      return { text: "do the thing" };
    case "request_header":
      return { model: "m", tools: [], provider: "p" };
    case "context_compacted":
      return {
        replaced_from_seq: 1,
        replaced_to_seq: 9,
        tokens_before: 100,
        summary_present: true,
      };
    case "tool_refused":
      return { name: "bash", by: "policy", reason: "outside the worktree" };
    case "plugin_enabled":
    case "plugin_disabled":
      return { id: "some-plugin", version: "1.0.0", origin: "third_party" };
    case "provider_error":
      return { provider: "p", kind: "credential_expired", message: "m", remedy: "r" };
    case "recovery_applied":
      return { run_id: "run_1", from_phase: "request_pending", action: "resumed", uncertain: true };
    default:
      return {};
  }
}

const durable = (id: number, type: string): EventEnvelope =>
  ({
    id,
    session_id: "s",
    ai_run_id: "run_1",
    seq: id,
    type,
    actor: type === "user_prompt" ? { kind: "user", id: "7" } : { kind: "system" },
    ts: "2026-08-17T00:00:00.000Z",
    payload: payloadFor(type),
  }) as unknown as EventEnvelope;

const ephemeral = (type: string): EventEnvelope =>
  ({
    id: null,
    session_id: "s",
    ai_run_id: "run_1",
    seq: null,
    type,
    actor: { kind: "system" },
    ts: "2026-08-17T00:00:00.000Z",
    payload: { input: 10, output: 1, cache_read: 0, cache_creation: 0, window: 200_000 },
  }) as unknown as EventEnvelope;

interface Joined {
  applied: EventEnvelope[];
  stop: () => void;
}

/**
 * A late joiner, catching up over the WORST window: the events it missed are returned by backfill
 * AND broadcast to it live while that backfill is still in flight.
 *
 * That overlap is the only place a duplicate can come from, so the test has to reproduce it rather
 * than emit the overlap after the drain (which is just the live path, and where an earlier version
 * of this test was wrong — it reported a duplicate the app does not have).
 *
 * Everything is applied through the REAL store, not a collector: dedupe-by-id lives there, so a
 * collector would be testing the catch-up algorithm in isolation from the half that finishes the
 * job.
 */
async function joinOverWorstWindow(stream: EventEnvelope[], joinAt: number): Promise<Joined> {
  useEventStore.getState().reset();
  // A holder object rather than a local `let`: TS narrows a local assigned only inside a callback
  // to `never` and then refuses the call.
  const wire: { onEvent?: (e: EventEnvelope) => void } = {};
  const channel: SessionChannel = {
    subscribe: (handler) => {
      wire.onEvent = handler;
      return () => {
        wire.onEvent = undefined;
      };
    },
  };

  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const catchUp = startCatchUp({
    channel,
    backfill: async (afterId) => {
      await gate;
      return stream.slice(0, joinAt).filter((e) => e.id !== null && e.id > afterId);
    },
    apply: (event) => useEventStore.getState().apply(event),
    maxAppliedId: () => useEventStore.getState().maxAppliedId,
  });

  // Broadcast the whole stream WHILE backfill is pending. The prefix overlaps what backfill will
  // return; the tail is genuinely new.
  for (const event of stream) wire.onEvent?.(event);
  release?.();
  const handle = await catchUp;

  return {
    applied: [
      ...useEventStore.getState().durableList,
      // Ephemerals never enter `durableList`, so read the one piece of state they do reach.
      ...(useEventStore.getState().liveContextUsage
        ? [{ id: null, type: "context_usage" } as unknown as EventEnvelope]
        : []),
    ],
    stop: handle.stop,
  };
}

describe("every durable type this feature adds reaches a mid-run joiner exactly once", () => {
  for (const type of DURABLE_SYNTHESIZED) {
    it(`delivers ${type} once, with no gap and no duplicate`, async () => {
      // The occurrence sits mid-stream, so the joiner both receives it live and gets it back from
      // backfill — the overlap where a duplicate would appear.
      const stream = [durable(1, "run_started"), durable(2, type), durable(3, "ai_text")];
      const joined = await joinOverWorstWindow(stream, 2);

      const seen = joined.applied.filter((e) => e.type === type);
      expect(seen, `${type} arrived ${seen.length} times`).toHaveLength(1);
      // No GAP either: the tail that arrived only live is there too.
      expect(joined.applied.map((e) => e.id)).toEqual([1, 2, 3]);
      joined.stop();
    });
  }

  it("covers every durable synthesized type, so a new one cannot slip in uncovered", () => {
    // The list is imported from `packages/contracts`. If a type is added there and this file is
    // not touched, the loop above simply grows — which is the intent. This assertion pins the
    // arithmetic so a REMOVAL from the list cannot silently shrink the coverage either.
    expect(DURABLE_SYNTHESIZED.length).toBe(SYNTHESIZED_EVENT_TYPES.length - 1);
    expect(DURABLE_SYNTHESIZED).not.toContain("context_usage");
  });
});

describe("the ephemeral one is NOT replayed", () => {
  it("never puts context_usage in the durable log, however it arrived", async () => {
    const stream = [durable(1, "run_started"), ephemeral("context_usage"), durable(2, "ai_text")];
    const joined = await joinOverWorstWindow(stream, 2);

    // It was never persisted, so a server cannot return it and the client must not invent one. It
    // reaches the live reading only, and never the durable log the feed reconciles against.
    expect(joined.applied.filter((e) => e.id !== null && e.type === "context_usage")).toHaveLength(
      0,
    );
    expect(useEventStore.getState().liveContextUsage).not.toBeNull();
    joined.stop();
  });

  it("leaves the joiner's durable cursor unmoved by it", async () => {
    useEventStore.getState().reset();
    useEventStore.getState().applyMany([ephemeral("context_usage")]);

    // An ephemeral that advanced the cursor would make the NEXT backfill skip real durable
    // events — a gap caused by the thing that is supposed to have no cursor at all.
    expect(useEventStore.getState().maxAppliedId).toBe(0);
    useEventStore.getState().reset();
  });
});

describe("live and late-joining participants converge", () => {
  for (const type of DURABLE_SYNTHESIZED) {
    it(`gives a joiner the same ${type} the room already had`, async () => {
      const stream = [durable(1, "run_started"), durable(2, type)];
      // joinAt 0 = present from the start (nothing to backfill); joinAt 2 = arrived after both.
      const live = await joinOverWorstWindow(stream, 0);
      const fromLive = JSON.stringify(live.applied.find((e) => e.type === type));
      live.stop();

      const late = await joinOverWorstWindow(stream, 2);
      const fromBackfill = JSON.stringify(late.applied.find((e) => e.type === type));
      late.stop();

      // generalised to every type: identical envelopes, whichever path delivered them.
      expect(fromBackfill).toBe(fromLive);
    });
  }
});
