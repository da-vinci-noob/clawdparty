import type { EventEnvelope, TerminalOutputPayload } from "@clawdparty/contracts";
import anser from "anser";
import type { FC } from "react";

// Bash output (chunked ~64KB by the normalizer), rendered with ANSI coloring via
// anser, scroll-capped so large output doesn't blow out the feed.
export const TerminalBlock: FC<{ event: EventEnvelope }> = ({ event }) => {
  const { text } = event.payload as TerminalOutputPayload;
  const html = anser.ansiToHtml(anser.escapeForHtml(text));
  return (
    <pre
      data-testid="feed-terminal"
      className="ml-[26px] max-h-64 overflow-auto rounded-[8px] border border-[#171d19] bg-black/60 p-3 font-mono text-xs text-[#c2c8c3]"
      // anser output is escaped first, then ANSI→span; safe to render.
      // biome-ignore lint/security/noDangerouslySetInnerHtml: anser escapes input before colorizing
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};
