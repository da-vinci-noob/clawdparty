import type { EventEnvelope, ToolFailedPayload, ToolStartedPayload } from "@clawdparty/contracts";
import { type FC, useState } from "react";

// A collapsible tool chip. Shows the SUMMARIZED input (path/command — never the
// full Edit/Write payload, which the event deliberately does not carry); the
// matching tool_finished/tool_failed event sets ok/failed state. `finishEvent`
// is the tool_finished/tool_failed for the same tool_use_id, if present.
interface Props {
  startEvent: EventEnvelope;
  finishEvent?: EventEnvelope;
}

export const ToolChip: FC<Props> = ({ startEvent, finishEvent }) => {
  const [open, setOpen] = useState(false);
  const start = startEvent.payload as ToolStartedPayload;
  const failed = finishEvent?.type === "tool_failed";
  const error = failed ? (finishEvent?.payload as ToolFailedPayload).error : undefined;
  const status = finishEvent ? (failed ? "failed" : "done") : "running";

  const statusColor = status === "failed" ? "#b58a7d" : status === "done" ? "#5fc79a" : "#79817b";

  return (
    <div data-testid="feed-tool-chip">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left text-[12px]"
      >
        <span className="flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[6px] border border-[#2a352d] bg-[#141a16]">
          <span
            className="h-[6px] w-[6px] rounded-full"
            style={{ background: failed ? "#b58a7d" : "#4fe89a" }}
          />
        </span>
        <span className="text-[#4fe89a]">clawd</span>
        <span className="text-[#565d58]">used</span>
        <span className="truncate text-[#5fc79a]">{start.name}</span>
        {start.input_summary && (
          <span className="truncate text-[#565d58]">· {start.input_summary}</span>
        )}
        <span className="ml-auto flex-none" style={{ color: statusColor }}>
          {status}
        </span>
      </button>
      {open && error && (
        <pre className="mt-1 whitespace-pre-wrap pl-[26px] text-[#b58a7d]">{error}</pre>
      )}
    </div>
  );
};
