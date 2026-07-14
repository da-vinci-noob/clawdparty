import type { FC } from "react";
import { useParams } from "react-router-dom";
import { AppShell } from "../components/app_shell";
import { RawEventList } from "../components/raw_event_list";

// Session-route shell. web-cable-client wires the live event transport: it
// subscribes to the session channel, catches up via REST backfill, and renders
// the durable log + streamed text as a raw list (activity-feed-rendering will
// replace the raw list with the rich feed).
export const SessionPage: FC = () => {
  const { sessionId } = useParams<{ sessionId: string }>();
  return (
    <AppShell>
      {sessionId ? (
        <RawEventList sessionId={sessionId} />
      ) : (
        <p data-testid="session-placeholder">No session</p>
      )}
    </AppShell>
  );
};
