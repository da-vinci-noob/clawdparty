import type { FC } from "react";
import { useParams } from "react-router-dom";
import { ActivityFeed } from "../components/activity_feed";
import { AppShell } from "../components/app_shell";

// Session-route shell. The center pane renders the live activity feed
// (activity-feed-rendering) over the cable-client store: streamed text, tool
// chips, terminal output, run banners, file-changed rows.
export const SessionPage: FC = () => {
  const { sessionId } = useParams<{ sessionId: string }>();
  return (
    <AppShell>
      {sessionId ? (
        <ActivityFeed sessionId={sessionId} />
      ) : (
        <p data-testid="session-placeholder">No session</p>
      )}
    </AppShell>
  );
};
