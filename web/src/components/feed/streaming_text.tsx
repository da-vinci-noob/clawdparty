import type { FC } from "react";
import { splitReasoning } from "../../helpers/reasoning_tags";
import { ThinkingBlock } from "./thinking_block";

// The trailing in-progress text of a live block: the accumulated ai_text_delta payload with a
// blinking cursor at the writing edge. Deliberately NOT markdown — half-written syntax
// (an unclosed fence, a lone `**`) renders as garbage, so streaming text stays literal until the
// durable ai_text settles and TextBlock renders it properly.
//
// Reasoning a model narrates inline (Nova's <thinking> span) is separated the same way it is
// once settled, so the participant does not watch XML tags arrive and then vanish. The cursor
// follows the writing edge into the reasoning box when that is where the model is writing.
export const StreamingText: FC<{ text: string }> = ({ text }) => {
  const segments = splitReasoning(text);
  const last = segments.length - 1;
  return (
    <>
      {segments.map((segment, at) =>
        segment.kind === "reasoning" ? (
          <ThinkingBlock
            key={`r-${at}-${segment.text.length}`}
            text={segment.text}
            streaming={at === last}
          />
        ) : (
          <div
            key={`a-${at}-${segment.text.length}`}
            data-testid="feed-streaming-text"
            className="pl-[26px] text-[13px] text-[#cdd2cd]"
          >
            {segment.text}
            {at === last && <Cursor />}
          </div>
        ),
      )}
    </>
  );
};

const Cursor: FC = () => (
  <span
    className="ml-[1px] inline-block h-[14px] w-[8px] translate-y-[2px] bg-[#3b9dff]"
    style={{
      animation: "cp-blink 1.1s step-end infinite",
      boxShadow: "0 0 8px rgba(59,157,255,.5)",
    }}
  />
);
