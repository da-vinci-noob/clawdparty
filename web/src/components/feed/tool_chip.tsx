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

  return (
    <div
      data-testid="feed-tool-chip"
      className="rounded border border-neutral-800 px-2 py-1 text-xs"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full gap-2 text-left"
      >
        <span className={failed ? "text-red-400" : "text-amber-400"}>{start.name}</span>
        <span className="truncate text-neutral-400">{start.input_summary}</span>
        <span className="ml-auto text-neutral-500">{status}</span>
      </button>
      {open && error && <pre className="mt-1 whitespace-pre-wrap text-red-300">{error}</pre>}
    </div>
  );
};
