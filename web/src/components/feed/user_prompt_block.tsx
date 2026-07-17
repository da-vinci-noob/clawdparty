import type { EventEnvelope, UserPromptPayload } from "@clawdparty/contracts";
import type { FC } from "react";
import { type ParticipantNames, actorLabel } from "../../helpers/participant_names";

// A human prompt that drove the run (initial or follow-up; run-scoped durable
// user_prompt). Visually distinct from Claude's ai_text: participant-attributed,
// in a user-accent bubble. Renders the text even when the name is not yet locally
// known (actorLabel falls back to a short id).
export const UserPromptBlock: FC<{ event: EventEnvelope; names?: ParticipantNames }> = ({
  event,
  names = new Map(),
}) => {
  const { text } = event.payload as UserPromptPayload;
  return (
    <div data-testid="feed-user-prompt">
      <div className="mb-[5px] flex items-center gap-2 text-[11px] text-[#565d58]">
        <span className="text-[#9aa39c]">{actorLabel(event.actor, names)}</span>
        <span>ran prompt</span>
      </div>
      <div className="flex gap-[10px]">
        <span className="text-[#4fe89a]" style={{ textShadow: "0 0 10px rgba(79,232,154,.5)" }}>
          ❯
        </span>
        <span className="whitespace-pre-wrap text-[#d4dbd2]">{text}</span>
      </div>
    </div>
  );
};
