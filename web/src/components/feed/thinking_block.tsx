import type { FC } from "react";

// A persistent, collapsible "thinking" block. Used for both the durable
// ai_thinking (settled) and the live-streaming thinking accumulator. Default
// expanded so live thinking is visible; click the summary to collapse. Visually
// distinct from Claude's answer text (dim, italic).
export const ThinkingBlock: FC<{ text: string; streaming?: boolean }> = ({ text, streaming }) => (
  <details open data-testid="feed-thinking" className="rounded bg-neutral-900/40 px-2 py-1 text-xs">
    <summary className="cursor-pointer select-none text-neutral-500">
      Thinking{streaming ? "…" : ""}
    </summary>
    <div className="mt-1 whitespace-pre-wrap italic text-neutral-400">
      {text}
      {streaming && <span className="animate-pulse">▍</span>}
    </div>
  </details>
);
