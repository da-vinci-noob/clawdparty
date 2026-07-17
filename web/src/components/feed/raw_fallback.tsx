import type { EventEnvelope } from "@clawdparty/contracts";
import { type FC, useState } from "react";

// Safe fallback for ai_raw / any type the feed does not render richly (e.g.
// ai_thinking until its UI lands). Collapsible raw view — never crashes the feed.
export const RawFallback: FC<{ event: EventEnvelope }> = ({ event }) => {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="feed-raw-fallback" className="text-[12px] text-[#565d58]">
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-left">
        <span className="text-[#4fe89a]">▸</span> {event.type}
      </button>
      {open && (
        <pre className="mt-1 whitespace-pre-wrap pl-[14px] text-[#79817b]">
          {JSON.stringify(event.payload)}
        </pre>
      )}
    </div>
  );
};
