import type { AiTextPayload, EventEnvelope } from "@clawdparty/contracts";
import type { FC } from "react";
import { splitReasoning } from "../../helpers/reasoning_tags";
import { Markdown } from "./markdown";
import { ThinkingBlock } from "./thinking_block";

// A completed Claude text block (durable ai_text). Live streaming text (the
// in-progress (ai_run_id, block) accumulator) is rendered separately by the feed
// as a trailing block; this renders the settled bubble as rendered markdown
// (Markdown keeps the `data-testid="feed-text"` wrapper).
//
// Reasoning some models narrate INSIDE the answer (Nova's literal <thinking> span) is shown as a
// reasoning block instead of prose — see `helpers/reasoning_tags`. The event keeps the text
// exactly as the model sent it; only the rendering separates the two.
export const TextBlock: FC<{ event: EventEnvelope }> = ({ event }) => {
  const { text } = event.payload as AiTextPayload;
  const segments = splitReasoning(text);
  if (segments.length === 1 && segments[0]?.kind === "answer") {
    return <Markdown>{text}</Markdown>;
  }
  return (
    <div className="space-y-2">
      {segments.map((segment, at) =>
        segment.kind === "reasoning" ? (
          <ThinkingBlock key={`r-${at}-${segment.text.length}`} text={segment.text} />
        ) : (
          <Markdown key={`a-${at}-${segment.text.length}`}>{segment.text}</Markdown>
        ),
      )}
    </div>
  );
};
