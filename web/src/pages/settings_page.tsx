import { type FC, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AuthTestTab } from "../components/settings/auth_test_tab";
import { ConfigurationTab } from "../components/settings/configuration_tab";
import { SkillsTab } from "../components/settings/skills_tab";
import { useHydrateParticipant } from "../hooks/use_hydrate_participant";

// The settings surface. Reached from the session, because a session is what decides which
// repo's connectors and skills are in play — even though providers and skills are host-wide.
//
// Tabs are added as they are BUILT, not as placeholders: an empty "coming soon" tab is worse than a
// tab that is not there yet, because it looks like a broken feature rather than an unbuilt one.
// Provider defaults join this list when they land.
//
// Everything here is readable by every role; the WRITE controls each tab adds are gated by the
// server's SessionPolicy (`manage_session` = owner), with the client only hiding buttons.

const TABS = [
  { id: "configuration", label: "Configuration" },
  { id: "auth", label: "Auth test" },
  { id: "skills", label: "Skills setup" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export const SettingsPage: FC = () => {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [tab, setTab] = useState<TabId>("configuration");
  useHydrateParticipant(sessionId ?? "");

  if (!sessionId) {
    return <p data-testid="settings-placeholder">No session</p>;
  }

  return (
    <main
      data-testid="settings-page"
      className="mx-auto flex min-h-screen w-full max-w-[820px] flex-col gap-5 bg-[#0a0a0a] px-6 py-7 font-mono text-[#e6e8e6]"
    >
      <header className="flex items-center gap-3">
        <h1 className="flex-1 text-[15px] font-semibold">Settings</h1>
        <Link
          to={`/sessions/${sessionId}`}
          data-testid="settings-back"
          className="rounded-[9px] border border-[#17231b] bg-[#0e140f] px-[11px] py-[6px] text-[12px] text-[#cdd2cd] hover:border-[#2c5580]"
        >
          ← back to session
        </Link>
      </header>

      <nav aria-label="Settings tabs" className="flex items-center gap-[2px]">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            data-testid={`settings-tab-${entry.id}`}
            onClick={() => setTab(entry.id)}
            className={`rounded-[8px] px-[12px] py-[7px] text-[12px] ${
              tab === entry.id
                ? "bg-[#0e140f] text-[#3b9dff]"
                : "text-[#7c847c] hover:text-[#aeb4ae]"
            }`}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <section aria-label={`${tab} settings`} className="min-h-0 flex-1">
        {tab === "configuration" && <ConfigurationTab sessionId={sessionId} />}
        {tab === "auth" && <AuthTestTab />}
        {tab === "skills" && <SkillsTab sessionId={sessionId} />}
      </section>
    </main>
  );
};
