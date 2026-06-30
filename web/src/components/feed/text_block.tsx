import type { AiTextPayload, EventEnvelope } from "@clawdparty/contracts";
import type { FC } from "react";

// A completed Claude text block (durable ai_text). Live streaming text (the
// in-progress (ai_run_id, block) accumulator) is rendered separately by the feed
// as a trailing block; this renders the settled bubble.
export const TextBlock: FC<{ event: EventEnvelope }> = ({ event }) => {
  const { text } = event.payload as AiTextPayload;
  return (
    <div data-testid="feed-text" className="whitespace-pre-wrap text-sm text-neutral-100">
      {text}
    </div>
  );
};
