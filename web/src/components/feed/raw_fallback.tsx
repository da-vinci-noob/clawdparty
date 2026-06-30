import type { EventEnvelope } from "@clawdparty/contracts";
import { type FC, useState } from "react";

// Safe fallback for ai_raw / any type the feed does not render richly (e.g.
// ai_thinking until its UI lands). Collapsible raw view — never crashes the feed.
export const RawFallback: FC<{ event: EventEnvelope }> = ({ event }) => {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="feed-raw-fallback" className="text-xs text-neutral-500">
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-left">
        ▸ {event.type}
      </button>
      {open && <pre className="mt-1 whitespace-pre-wrap">{JSON.stringify(event.payload)}</pre>}
    </div>
  );
};
