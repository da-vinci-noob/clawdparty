import type { FC } from "react";
import { useParams } from "react-router-dom";
import { ActivityFeed } from "../components/activity_feed";
import { AppShell } from "../components/app_shell";
import { ChatPanel } from "../components/chat_panel";
import { InterruptButton } from "../components/interrupt_button";
import { ParticipantList } from "../components/participant_list";
import { PromptComposer } from "../components/prompt_composer";

// The full session workspace: live activity feed (center) + prompt composer and
// interrupt (footer, role-gated), chat panel + participant list (right sidebar).
export const SessionPage: FC = () => {
  const { sessionId } = useParams<{ sessionId: string }>();
  if (!sessionId) {
    return <p data-testid="session-placeholder">No session</p>;
  }
  return (
    <AppShell
      sidebar={<ParticipantList />}
      chat={<ChatPanel sessionId={sessionId} />}
      footer={
        <div className="flex items-center gap-2 border-t border-neutral-800 px-2 py-1">
          <InterruptButton />
          <div className="flex-1">
            <PromptComposer sessionId={sessionId} />
          </div>
        </div>
      }
    >
      <ActivityFeed sessionId={sessionId} />
    </AppShell>
  );
};
