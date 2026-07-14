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
    <div data-testid="feed-user-prompt" className="rounded bg-sky-950/40 px-2 py-1">
      <span className="text-xs text-sky-400">{actorLabel(event.actor, names)}</span>
      <p className="whitespace-pre-wrap text-sm text-neutral-100">{text}</p>
    </div>
  );
};
