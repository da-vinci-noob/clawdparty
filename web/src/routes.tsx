import type { FC } from "react";
import { Route, Routes } from "react-router-dom";
import { LandingPage } from "./pages/landing_page";
import { SessionPage } from "./pages/session_page";
import { SessionsPage } from "./pages/sessions_page";

// Route map: the landing/join page, the sessions history view (reached from the
// header "sessions" link), and the live session workspace.
export const AppRoutes: FC = () => (
  <Routes>
    <Route path="/" element={<LandingPage />} />
    <Route path="/sessions" element={<SessionsPage />} />
    <Route path="/sessions/:sessionId" element={<SessionPage />} />
  </Routes>
);
