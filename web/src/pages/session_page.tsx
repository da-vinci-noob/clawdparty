import type { FC } from "react";
import { useParams } from "react-router-dom";
import { ActivityFeed } from "../components/activity_feed";
import { AppShell } from "../components/app_shell";
import { ChangeDirectory } from "../components/change_directory";
import { ChatPanel } from "../components/chat_panel";
import { DiffView } from "../components/diff_view";
import { InterruptButton } from "../components/interrupt_button";
import { InvitePanel } from "../components/invite_panel";
import { PromptComposer } from "../components/prompt_composer";
import { SessionSidebar } from "../components/session/session_sidebar";
import { TerminalTitlebar } from "../components/session/terminal_titlebar";
import { useHydrateParticipant } from "../hooks/use_hydrate_participant";
import { useSessionEvents } from "../hooks/use_session_events";
import { selectAwaitingReviewRunId, useEventStore } from "../stores/event_store";

// The full session workspace, styled to the dark-green 3-column design: left rail
// (mock session list + real owner controls), center terminal (titlebar · live feed ·
// composer), right room chat. The cable catch-up runs HERE (one subscription for the
// whole page); a backfill 404 (unknown session OR not a participant) renders a
// not-found state instead of a blank working shell.
export const SessionPage: FC = () => {
  const { sessionId } = useParams<{ sessionId: string }>();
  const status = useSessionEvents(sessionId ?? "");
  useHydrateParticipant(sessionId ?? "");
  const reviewRunId = useEventStore(selectAwaitingReviewRunId);

  if (!sessionId) {
    return <p data-testid="session-placeholder">No session</p>;
  }

  if (status === "not_found") {
    return (
      <main
        data-testid="session-not-found"
        className="grid h-screen place-items-center bg-[#0d0f0e] text-[#e6ebe4]"
      >
        <div className="space-y-2 text-center">
          <h1 className="text-lg font-semibold">Session not available</h1>
          <p className="text-sm text-[#a4aca6]">
            This session doesn’t exist, or you haven’t joined it. Open your invite link to join.
          </p>
          <a href="/" className="inline-block text-sm text-[#4fe89a] underline">
            Go to join screen
          </a>
        </div>
      </main>
    );
  }

  return (
    <AppShell
      sidebar={
        <SessionSidebar
          ownerControls={
            <>
              <InvitePanel sessionId={sessionId} />
              <ChangeDirectory sessionId={sessionId} />
            </>
          }
        />
      }
      titlebar={<TerminalTitlebar />}
      chat={<ChatPanel sessionId={sessionId} />}
      composer={
        <>
          <div className="relative z-[2] flex justify-end px-[18px]">
            <InterruptButton />
          </div>
          <PromptComposer sessionId={sessionId} />
        </>
      }
    >
      {reviewRunId && (
        <div className="cp-diff-in sticky top-0 z-[3] mb-4 rounded-[13px] border border-[#1d3652] bg-[#0c0e0c] p-[18px] shadow-[0_18px_40px_-12px_rgba(0,0,0,.7)]">
          <DiffView runId={reviewRunId} />
        </div>
      )}
      <ActivityFeed />
    </AppShell>
  );
};
