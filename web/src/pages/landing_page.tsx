import type { FC } from "react";

// Landing / join placeholder. No join/auth flow — that is Week 2.
export const LandingPage: FC = () => (
  <main className="grid h-screen place-items-center bg-neutral-950 text-neutral-100">
    <p data-testid="landing-placeholder">clawdparty — join a session (placeholder)</p>
  </main>
);
