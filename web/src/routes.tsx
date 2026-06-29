import type { FC } from "react";
import { Route, Routes } from "react-router-dom";
import { LandingPage } from "./pages/landing_page";
import { SessionPage } from "./pages/session_page";

// W1 route skeleton: a landing/join placeholder and a session-route shell. No
// guards, no role-gating, no join flow (Week 2).
export const AppRoutes: FC = () => (
  <Routes>
    <Route path="/" element={<LandingPage />} />
    <Route path="/sessions/:sessionId" element={<SessionPage />} />
  </Routes>
);
