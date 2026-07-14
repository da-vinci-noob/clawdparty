// Minimal raw-list view proving end-to-end live delivery while treating each
// event's `payload` as OPAQUE (no dependency on per-type payload shapes). This is
// the web-cable-client delivery proof; activity-feed-rendering replaces it with
// the rich feed. Renders the store's durable log + in-progress streamed text.

import type { FC } from "react";
import { useSessionEvents } from "../hooks/use_session_events";
import { selectDurableEvents, useEventStore } from "../stores/event_store";

interface Props {
  sessionId: string;
}

export const RawEventList: FC<Props> = ({ sessionId }) => {
  useSessionEvents(sessionId);
  const durable = useEventStore(selectDurableEvents);
  const textByBlock = useEventStore((s) => s.textByBlock);

  return (
    <div data-testid="raw-event-list" className="space-y-1 font-mono text-xs text-neutral-300">
      {durable.map((event) => (
        <div key={event.id ?? `${event.type}-${event.ts}`} data-testid="raw-event">
          <span className="text-neutral-500">#{event.id} </span>
          <span className="text-sky-400">{event.type}</span>
          <span className="text-neutral-500"> {event.actor.kind} </span>
          <span className="text-neutral-400">{JSON.stringify(event.payload)}</span>
        </div>
      ))}
      {[...textByBlock.entries()].map(([block, text]) => (
        <div key={block} data-testid="streaming-text" className="text-emerald-400">
          ▍{text}
        </div>
      ))}
    </div>
  );
};
