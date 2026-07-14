// use_session_events — wires the ActionCable subscription to the gap-free
// catch-up (CableController) and the Zustand store for one session. Subscribes
// ONCE, backfills, drains, goes live; re-runs ONLY backfill+drain from the store's
// max applied id on reconnect (dedupe-by-id makes the re-drain idempotent).

import type { EventEnvelope } from "@clawdparty/contracts";
import { useEffect } from "react";
import { fetchBackfill } from "../helpers/backfill";
import { useConsumer } from "../lib/action_cable_provider";
import { CableController, type SessionChannel } from "../lib/cable";
import { useEventStore } from "../stores/event_store";

export function useSessionEvents(sessionId: string): void {
  const consumer = useConsumer();

  useEffect(() => {
    let controller: CableController | null = null;

    const channel: SessionChannel = {
      subscribe(onEvent) {
        const sub = consumer.subscriptions.create(
          { channel: "SessionChannel", session_id: sessionId },
          {
            received(data: unknown) {
              onEvent(data as EventEnvelope);
            },
            // Reconnect: re-run ONLY backfill+drain (do not re-subscribe).
            connected() {
              void controller?.catchUp();
            },
          },
        );
        return () => sub.unsubscribe();
      },
    };

    controller = new CableController({
      channel,
      backfill: (afterId) => fetchBackfill(sessionId, afterId),
      apply: (event) => useEventStore.getState().apply(event),
      maxAppliedId: () => useEventStore.getState().maxAppliedId,
    });
    controller.start();

    return () => controller?.stop();
  }, [consumer, sessionId]);
}
