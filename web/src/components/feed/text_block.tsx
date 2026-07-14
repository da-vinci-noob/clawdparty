import type { AiTextPayload, EventEnvelope } from "@clawdparty/contracts";
import type { FC } from "react";
import { Markdown } from "./markdown";

// A completed Claude text block (durable ai_text). Live streaming text (the
// in-progress (ai_run_id, block) accumulator) is rendered separately by the feed
// as a trailing block; this renders the settled bubble as rendered markdown
// (Markdown keeps the `data-testid="feed-text"` wrapper).
export const TextBlock: FC<{ event: EventEnvelope }> = ({ event }) => {
  const { text } = event.payload as AiTextPayload;
  return <Markdown>{text}</Markdown>;
};
