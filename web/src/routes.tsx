import type { FC } from "react";
import { Route, Routes } from "react-router-dom";
import { LandingPage } from "./pages/landing_page";
import { SessionPage } from "./pages/session_page";
import { SessionsPage } from "./pages/sessions_page";
import { SettingsPage } from "./pages/settings_page";

// Route map: the landing/join page, the sessions history view (reached from the
// header "sessions" link), the live session workspace, and its settings page.
export const AppRoutes: FC = () => (
  <Routes>
    <Route path="/" element={<LandingPage />} />
    <Route path="/sessions" element={<SessionsPage />} />
    <Route path="/sessions/:sessionId" element={<SessionPage />} />
    {/* Its own route rather than a modal: settings are a place you go and stay a while
        (an auth test takes seconds per provider), and a link is shareable. */}
    <Route path="/sessions/:sessionId/settings" element={<SettingsPage />} />
  </Routes>
);
