import type { EventEnvelope } from "@clawdparty/contracts";
import { type FC, useState } from "react";

// Safe fallback for ai_raw / any type the feed does not render richly (e.g.
// ai_thinking until its UI lands). Collapsible raw view — never crashes the feed.
export const RawFallback: FC<{ event: EventEnvelope }> = ({ event }) => {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="feed-raw-fallback" className="text-[12px] text-[#6b726b]">
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-left">
        <span className="text-[#3b9dff]">▸</span> {event.type}
      </button>
      {open && (
        <pre className="mt-1 whitespace-pre-wrap pl-[14px] text-[#7c847c]">
          {JSON.stringify(event.payload)}
        </pre>
      )}
    </div>
  );
};
