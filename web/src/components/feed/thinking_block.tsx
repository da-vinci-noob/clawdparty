import type { FC } from "react";

// A persistent, collapsible "thinking" block. Used for both the durable
// ai_thinking (settled) and the live-streaming thinking accumulator. Default
// expanded so live thinking is visible; click the summary to collapse. Visually
// distinct from Claude's answer text (dim, italic).
//
// Rendered ONLY when there is readable thinking text: some providers (notably
// Amazon Bedrock) return signature-only, ENCRYPTED thinking with no plaintext —
// there is nothing to show, so an empty "Thinking" block would just be noise.
export const ThinkingBlock: FC<{ text: string; streaming?: boolean }> = ({ text, streaming }) => {
  if (!text.trim()) {
    return null;
  }
  return (
    <details
      open
      data-testid="feed-thinking"
      className="rounded-[8px] border border-[#1d221f] bg-[#0f1211]/60 px-3 py-2 text-[12px]"
    >
      <summary className="cursor-pointer select-none text-[#565d58]">
        Thinking{streaming ? "…" : ""}
      </summary>
      <div className="mt-1 whitespace-pre-wrap italic text-[#79817b]">
        {text}
        {streaming && (
          <span
            className="ml-[1px] inline-block h-[12px] w-[7px] translate-y-[2px] bg-[#4fe89a]"
            style={{ animation: "cp-blink 1.1s step-end infinite" }}
          />
        )}
      </div>
    </details>
  );
};
