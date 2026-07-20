import { type FC, type FormEvent, useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { LandingCta } from "../components/landing/landing_cta";
import { LandingFooter } from "../components/landing/landing_footer";
import { type HeroForm, LandingHero } from "../components/landing/landing_hero";
import { LandingHowItWorks } from "../components/landing/landing_how_it_works";
import { LandingNav } from "../components/landing/landing_nav";
import { LandingRoles } from "../components/landing/landing_roles";
import { LandingSecurity } from "../components/landing/landing_security";
import { LandingSessionPreview } from "../components/landing/landing_session_preview";
import { type CurrentParticipant, useParticipantStore } from "../stores/participant_store";

type Mode = "join" | "create";
type SessionMode = "review" | "chat";
type Theme = "dark" | "light";

const THEME_KEY = "cp-theme";

// Landing: the full marketing page for clawdparty — an amber/orange, terminal-
// inspired layout with a light/dark toggle, wrapped around the two bootstrap
// entry points (both unauthenticated on the trusted LAN). The hero holds the
// join/create form:
//  - Join:   invite token + display name → POST /api/participants
//  - Create: session title + display name (+ session mode + working dir)
//            → POST /api/sessions (creator = owner)
// Both return the participant + set the signed httpOnly clawd_uid cookie; the
// client never reads the cookie, it tracks "who am I" from the response and
// routes into the session. An invite link (?token=…) opens straight in Join mode.
export const LandingPage: FC = () => {
  const navigate = useNavigate();
  const setCurrent = useParticipantStore((s) => s.setCurrent);
  const [searchParams] = useSearchParams();

  // Theme is persisted in localStorage and applied as a class on the landing
  // wrapper only (never document root) so the session workspace is untouched.
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });
  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "light" ? "dark" : "light";
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        // best-effort; a blocked localStorage must not break the toggle
      }
      return next;
    });
  }, []);

  const [tab, setTab] = useState<Mode>("join");
  const [token, setToken] = useState(() => searchParams.get("token") ?? "");
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<SessionMode>("review");
  const [directory, setDirectory] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // An invite link deep-links into Join with the token prefilled.
  useEffect(() => {
    if (searchParams.get("token")) {
      setTab("join");
    }
  }, [searchParams]);

  const submit = async (url: string, body: Record<string, string>, verb: string): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const parsed = (await res.json().catch(() => null)) as {
          errors?: { message: string }[];
        } | null;
        setError(parsed?.errors?.[0]?.message ?? `${verb} failed (${res.status})`);
        return;
      }
      const participant = (await res.json()) as CurrentParticipant;
      setCurrent(participant);
      navigate(`/sessions/${participant.session_id}`);
    } catch {
      setError("Network error — is the clawdparty host reachable?");
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    if (tab === "join") {
      void submit("/api/participants", { token, name }, "Join");
      return;
    }
    const body: Record<string, string> = { title, name, mode };
    if (directory.trim()) {
      body.repository_path = directory.trim();
    }
    void submit("/api/sessions", body, "Create");
  };

  const form: HeroForm = {
    tab,
    token,
    name,
    title,
    mode,
    directory,
    busy,
    error,
    setTab,
    setToken,
    setName,
    setTitle,
    setMode,
    setDirectory,
    onSubmit,
  };

  // Landmarks: <nav> (navigation) + hero <header> (banner) + <main> (content) +
  // <footer> (contentinfo) all live at wrapper scope. Nesting them under a single
  // <main> would collapse the banner/contentinfo roles, so the wrapper is a <div>.
  return (
    <div
      id="top"
      className={`cp-landing min-h-screen w-full overflow-x-hidden font-mono${
        theme === "light" ? " cp-light" : ""
      }`}
    >
      <LandingNav theme={theme} onToggleTheme={toggleTheme} />
      <LandingHero form={form} />
      <main>
        <LandingSessionPreview />
        <LandingHowItWorks />
        <LandingRoles />
        <LandingSecurity />
        <LandingCta />
      </main>
      <LandingFooter />
    </div>
  );
};
