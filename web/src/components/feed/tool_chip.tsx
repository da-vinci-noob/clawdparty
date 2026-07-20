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

  const statusColor = status === "failed" ? "#f0a8a8" : status === "done" ? "#3b9dff" : "#7c847c";

  return (
    <div data-testid="feed-tool-chip">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left text-[12px]"
      >
        <span className="flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[6px] border border-[#1c2a20] bg-[#0e140f]">
          <span
            className="h-[6px] w-[6px] rounded-full"
            style={{ background: failed ? "#f0a8a8" : "#3b9dff" }}
          />
        </span>
        <span className="text-[#3b9dff]">clawd</span>
        <span className="text-[#6b726b]">used</span>
        <span className="truncate text-[#3b9dff]">{start.name}</span>
        {start.input_summary && (
          <span className="truncate text-[#6b726b]">· {start.input_summary}</span>
        )}
        <span className="ml-auto flex-none" style={{ color: statusColor }}>
          {status}
        </span>
      </button>
      {open && error && (
        <pre className="mt-1 whitespace-pre-wrap pl-[26px] text-[#f0a8a8]">{error}</pre>
      )}
    </div>
  );
};
