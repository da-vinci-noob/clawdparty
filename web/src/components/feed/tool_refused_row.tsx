import type { EventEnvelope } from "@clawdparty/contracts";
import type { FC } from "react";

/**
 * A refused tool call.
 *
 * Rendered as its own row rather than folded into the tool chip, and that is the
 * point: a refusal is not a failure. A failure means Claude tried and the tool
 * broke; a refusal means the room's own policy stopped it. Showing them the same
 * way would make "we blocked this" look like "this crashed", and the participant
 * would have no idea a rule exists.
 *
 * Names WHO refused and WHY, because everyone in the shared room sees the same
 * feed and a refusal with no attribution reads as the session mysteriously stalling
 *.
 */
export const ToolRefusedRow: FC<{ event: EventEnvelope }> = ({ event }) => {
  const payload = event.payload as { name?: string; by?: string; reason?: string };
  const reason = payload.reason ?? "no reason given";

  return (
    <div
      data-testid="feed-tool-refused"
      className="flex items-start gap-2 rounded-[8px] border border-[#3a2a17] bg-[#1a1206] px-3 py-2 text-[12px]"
    >
      <span className="mt-[2px] shrink-0 text-[#e0a04a]" aria-hidden="true">
        ⃠
      </span>
      <div className="min-w-0">
        <div className="text-[#e0a04a]">
          refused <span className="font-semibold">{payload.name ?? "tool"}</span>
          {payload.by && <span className="text-[#8a7a5a]"> · by {payload.by}</span>}
        </div>
        <div data-testid="feed-tool-refused-reason" className="break-words text-[#a8987a]">
          {reason}
        </div>
      </div>
    </div>
  );
};
