import type { FC } from "react";
import { useParams } from "react-router-dom";
import { ActivityFeed } from "../components/activity_feed";
import { AppShell } from "../components/app_shell";
import { ChatPanel } from "../components/chat_panel";
import { InterruptButton } from "../components/interrupt_button";
import { ParticipantList } from "../components/participant_list";
import { PromptComposer } from "../components/prompt_composer";
import { useSessionEvents } from "../hooks/use_session_events";

// The full session workspace: live activity feed (center) + prompt composer and
// interrupt (footer, role-gated), chat panel + participant list (right sidebar).
// The cable catch-up runs HERE (one subscription for the whole page); a backfill
// 404 (unknown session OR not a participant) renders a not-found state instead of
// a blank working shell.
export const SessionPage: FC = () => {
  const { sessionId } = useParams<{ sessionId: string }>();
  const status = useSessionEvents(sessionId ?? "");

  if (!sessionId) {
    return <p data-testid="session-placeholder">No session</p>;
  }

  if (status === "not_found") {
    return (
      <main
        data-testid="session-not-found"
        className="grid h-screen place-items-center bg-neutral-950 text-neutral-100"
      >
        <div className="space-y-2 text-center">
          <h1 className="text-lg font-semibold">Session not available</h1>
          <p className="text-sm text-neutral-400">
            This session doesn’t exist, or you haven’t joined it. Open your invite link to join.
          </p>
          <a href="/" className="inline-block text-sm text-sky-400 underline">
            Go to join screen
          </a>
        </div>
      </main>
    );
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
      <ActivityFeed />
    </AppShell>
  );
};
