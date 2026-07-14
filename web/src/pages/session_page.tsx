import type { FC } from "react";
import { AppShell } from "../components/app_shell";

// Session-route shell. Renders the static app shell only — no data, no cable,
// no role-gating. Week 2 wires the live activity stream into the shell regions.
export const SessionPage: FC = () => (
  <AppShell>
    <p data-testid="session-placeholder">Session activity (placeholder)</p>
  </AppShell>
);
