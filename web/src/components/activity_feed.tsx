import type { EventEnvelope } from "@clawdparty/contracts";
import type { FC } from "react";
import type { ParticipantNames } from "../helpers/participant_names";
import { selectDurableEvents, useEventStore } from "../stores/event_store";
import { FileChangedRow } from "./feed/file_changed_row";
import { RawFallback } from "./feed/raw_fallback";
import { RunBanner } from "./feed/run_banner";
import { TerminalBlock } from "./feed/terminal_block";
import { TextBlock } from "./feed/text_block";
import { ToolChip } from "./feed/tool_chip";
import { UserPromptBlock } from "./feed/user_prompt_block";

// Cap the rendered durable set so a long run doesn't render thousands of nodes.
const FEED_CAP = 500;

const RUN_LIFECYCLE = new Set([
  "run_started",
  "run_finished",
  "run_failed",
  "run_interrupted",
  "changeset_ready",
]);

interface Props {
  names?: ParticipantNames;
}

// The center-pane activity feed: renders the cable-client store's durable log
// richly (per the frozen taxonomy) plus the trailing in-progress streamed text.
// Read-only; no shell input path. Unknown/ai_raw types degrade to a safe fallback.
export const ActivityFeed: FC<Props> = ({ names = new Map() }) => {
  const durable = useEventStore(selectDurableEvents);
  const textByBlock = useEventStore((s) => s.textByBlock);

  // Pair each tool_started with its tool_finished/tool_failed (same tool_use_id).
  const finishByToolId = new Map<string, EventEnvelope>();
  for (const e of durable) {
    if (e.type === "tool_finished" || e.type === "tool_failed") {
      const id = (e.payload as { tool_use_id?: string }).tool_use_id;
      if (id) finishByToolId.set(id, e);
    }
  }

  const windowed = durable.slice(-FEED_CAP);

  return (
    <div data-testid="activity-feed" className="space-y-2">
      {windowed.map((event) => (
        <div key={event.id ?? `${event.type}-${event.ts}`}>
          {renderEvent(event, finishByToolId, names)}
        </div>
      ))}
      {[...textByBlock.entries()].map(([block, text]) => (
        <div
          key={`live-${block}`}
          data-testid="feed-streaming-text"
          className="text-sm text-emerald-300"
        >
          {text}
          <span className="animate-pulse">▍</span>
        </div>
      ))}
    </div>
  );
};

function renderEvent(
  event: EventEnvelope,
  finishByToolId: Map<string, EventEnvelope>,
  names: ParticipantNames,
) {
  switch (event.type) {
    case "user_prompt":
      return <UserPromptBlock event={event} names={names} />;
    case "ai_text":
      return <TextBlock event={event} />;
    case "tool_started": {
      const id = (event.payload as { tool_use_id?: string }).tool_use_id;
      return <ToolChip startEvent={event} finishEvent={id ? finishByToolId.get(id) : undefined} />;
    }
    case "tool_finished":
    case "tool_failed":
      // Rendered as part of their tool_started chip; skip standalone.
      return null;
    case "terminal_output":
      return <TerminalBlock event={event} />;
    case "file_changed":
      return <FileChangedRow event={event} />;
    default:
      if (RUN_LIFECYCLE.has(event.type)) {
        return <RunBanner event={event} names={names} />;
      }
      // ai_thinking (no rich UI yet), ai_raw, and anything else → safe fallback.
      return <RawFallback event={event} />;
  }
}
