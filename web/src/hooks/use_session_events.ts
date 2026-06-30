// use_session_events — wires the ActionCable subscription to the gap-free
// catch-up (CableController) and the Zustand store for one session. Subscribes
// ONCE, backfills, drains, goes live; re-runs ONLY backfill+drain from the store's
// max applied id on reconnect (dedupe-by-id makes the re-drain idempotent).

import type { EventEnvelope } from "@clawdparty/contracts";
import { useEffect, useState } from "react";
import { fetchBackfill } from "../helpers/backfill";
import { useConsumer } from "../lib/action_cable_provider";
import { CableController, type SessionChannel } from "../lib/cable";
import { useEventStore } from "../stores/event_store";

// "loading" until the first backfill resolves; "ok" once it does; "not_found" if
// the session is unknown or the requester has not joined (the backfill 404s).
export type SessionEventsStatus = "loading" | "ok" | "not_found";

export function useSessionEvents(sessionId: string): SessionEventsStatus {
  const consumer = useConsumer();
  const [status, setStatus] = useState<SessionEventsStatus>("loading");

  useEffect(() => {
    setStatus("loading");
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
      backfill: async (afterId) => {
        const events = await fetchBackfill(sessionId, afterId);
        setStatus("ok");
        return events;
      },
      apply: (event) => useEventStore.getState().apply(event),
      maxAppliedId: () => useEventStore.getState().maxAppliedId,
      onNotFound: () => setStatus("not_found"),
    });
    controller.start();

    return () => controller?.stop();
  }, [consumer, sessionId]);

  return status;
}
