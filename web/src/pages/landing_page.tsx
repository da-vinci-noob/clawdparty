import { type FC, type FormEvent, useCallback, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { DirectoryPicker } from "../components/directory_picker";
import { LandingFeatures } from "../components/landing/landing_features";
import { LandingFooter } from "../components/landing/landing_footer";
import { LandingHero } from "../components/landing/landing_hero";
import { LandingNav } from "../components/landing/landing_nav";
import { LandingShowcase } from "../components/landing/landing_showcase";
import { type CurrentParticipant, useParticipantStore } from "../stores/participant_store";

type Mode = "join" | "create";
type SessionMode = "review" | "chat";

// Landing: a full marketing page (nav · hero · features · "decide together"
// showcase · footer) wrapped around the two bootstrap entry points, both
// unauthenticated on the trusted LAN. The #cp-start module holds:
//  - Join:   invite token + display name → POST /api/participants
//  - Create: session title + display name (+ session type + working dir)
//            → POST /api/sessions (creator = owner)
// Both return the participant + set the signed httpOnly clawd_uid cookie; the
// client never reads the cookie, it tracks "who am I" from the response and
// routes into the session. An invite link (?token=…) opens straight in Join mode.
export const LandingPage: FC = () => {
  const navigate = useNavigate();
  const setCurrent = useParticipantStore((s) => s.setCurrent);
  const [searchParams] = useSearchParams();

  const [mode, setMode] = useState<Mode>("join");
  const [token, setToken] = useState(() => searchParams.get("token") ?? "");
  const [title, setTitle] = useState("");
  const [name, setName] = useState("");
  // Session run mode + working directory (both modes) for the create form.
  const [sessionMode, setSessionMode] = useState<SessionMode>("review");
  const [directory, setDirectory] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const scrollToStart = useCallback(() => {
    document.getElementById("cp-start")?.scrollIntoView({ behavior: "smooth" });
  }, []);

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
      setError("Network error");
    } finally {
      setBusy(false);
    }
  };

  const onJoin = (e: FormEvent): void => {
    e.preventDefault();
    void submit("/api/participants", { token, name }, "Join");
  };
  const onCreate = (e: FormEvent): void => {
    e.preventDefault();
    const body: Record<string, string> = { title, name, mode: sessionMode };
    if (directory.trim()) {
      body.repository_path = directory.trim();
    }
    void submit("/api/sessions", body, "Create");
  };

  return (
    <main className="min-h-screen w-full overflow-x-hidden bg-[#0d0f0e] text-[#e6ebe4]">
      <LandingNav onStart={scrollToStart} />
      <LandingHero onStart={scrollToStart} />
      <LandingFeatures />
      <LandingShowcase />

      {/* ===== START MODULE (Join / Create) ===== */}
      <section id="cp-start" className="px-8 pb-24 pt-10">
        <div className="mx-auto max-w-[560px]">
          <div className="mb-[34px] text-center">
            <h2 className="mb-[10px] text-[34px] font-bold tracking-[-1px]">
              Get the party started
            </h2>
            <p className="text-[16px] text-[#a4aca6]">
              Spin up a fresh session or hop into one with an invite token.
            </p>
          </div>

          <div
            className="overflow-hidden rounded-[18px] border border-[#1d221f] bg-[#0f1211]"
            style={{ boxShadow: "0 30px 80px rgba(0,0,0,.5)" }}
          >
            {/* tabs */}
            <div
              className="flex gap-[6px] border-b border-[#171d19] bg-[#0c0f0e] p-[10px]"
              data-testid="landing-mode-toggle"
            >
              <TabButton active={mode === "join"} onClick={() => setMode("join")}>
                Join
              </TabButton>
              <TabButton active={mode === "create"} onClick={() => setMode("create")}>
                Create
              </TabButton>
            </div>

            <div className="px-[26px] pb-[30px] pt-7">
              {mode === "join" ? (
                <form onSubmit={onJoin} data-testid="join-form" className="space-y-[14px]">
                  <div className="font-mono text-[13px] text-[#4fe89a]">
                    {"// join an existing session"}
                  </div>
                  <Field label="Invite token">
                    <TextInput
                      aria-label="Invite token"
                      placeholder="Paste your invite token"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                    />
                  </Field>
                  <Field label="Display name">
                    <TextInput
                      aria-label="Display name"
                      placeholder="How the room sees you"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </Field>
                  <SubmitButton busy={busy} idle="Join the party" pending="Joining…" />
                </form>
              ) : (
                <form onSubmit={onCreate} data-testid="create-form" className="space-y-[14px]">
                  <div className="font-mono text-[13px] text-[#4fe89a]">
                    {"// start a new session"}
                  </div>
                  <Field label="Session title">
                    <TextInput
                      aria-label="Session title"
                      placeholder="What are we working on?"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                  </Field>
                  <Field label="Display name">
                    <TextInput
                      aria-label="Display name"
                      placeholder="How the room sees you"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </Field>

                  <div>
                    <FieldLabel>Session type</FieldLabel>
                    <div className="flex gap-[10px]">
                      <SessionTypeCard
                        glyph="❯"
                        title="Chat"
                        subtitle="Discuss & decide together"
                        active={sessionMode === "chat"}
                        onClick={() => setSessionMode("chat")}
                      />
                      <SessionTypeCard
                        glyph="⎇"
                        title="Pair coding"
                        subtitle="Point clawd at a repo"
                        active={sessionMode === "review"}
                        onClick={() => setSessionMode("review")}
                      />
                    </div>
                  </div>

                  <div>
                    <FieldLabel>Working directory</FieldLabel>
                    <DirectoryPicker value={directory} onChange={setDirectory} />
                  </div>

                  <SubmitButton busy={busy} idle="Create session" pending="Creating…" />
                </form>
              )}

              {error && (
                <p data-testid="join-error" className="mt-4 text-center text-sm text-[#b58a7d]">
                  {error}
                </p>
              )}
            </div>
          </div>
        </div>
      </section>

      <LandingFooter />
    </main>
  );
};

const TabButton: FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({
  active,
  onClick,
  children,
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`flex-1 rounded-[9px] py-[9px] font-mono text-[13px] font-semibold transition ${
      active ? "bg-[#141a16] text-[#4fe89a]" : "text-[#79817b] hover:text-[#a4aca6]"
    }`}
  >
    {children}
  </button>
);

// Presentational field caption. Inputs carry their own aria-label, so this is a
// styled <div> (not a <label>) — avoids an orphaned label with no control.
const FieldLabel: FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="mb-[7px] block font-mono text-[11px] uppercase tracking-[0.5px] text-[#565d58]">
    {children}
  </div>
);

const Field: FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <FieldLabel>{label}</FieldLabel>
    {children}
  </div>
);

const TextInput: FC<React.InputHTMLAttributes<HTMLInputElement>> = (props) => (
  <input
    type="text"
    {...props}
    className="w-full rounded-[10px] border border-[#232a25] bg-[#0b0e0c] px-[15px] py-[13px] font-mono text-[14px] text-[#e6ebe4] outline-none transition focus:border-[#4fe89a] focus:shadow-[0_0_0_3px_rgba(79,232,154,.12)]"
  />
);

const SessionTypeCard: FC<{
  glyph: string;
  title: string;
  subtitle: string;
  active: boolean;
  onClick: () => void;
}> = ({ glyph, title, subtitle, active, onClick }) => (
  <button
    type="button"
    aria-pressed={active}
    onClick={onClick}
    className={`flex-1 rounded-[10px] border p-[13px] text-left transition ${
      active
        ? "border-[#4fe89a] bg-[#17241b]"
        : "border-[#232a25] bg-[#0b0e0c] hover:border-[#374039]"
    }`}
  >
    <div className="mb-[5px] flex items-center gap-2">
      <span className="font-mono text-[14px] text-[#4fe89a]">{glyph}</span>
      <span className="text-[14px] font-semibold">{title}</span>
    </div>
    <div className="text-xs leading-[1.4] text-[#79817b]">{subtitle}</div>
  </button>
);

const SubmitButton: FC<{ busy: boolean; idle: string; pending: string }> = ({
  busy,
  idle,
  pending,
}) => (
  <button
    type="submit"
    disabled={busy}
    className="mt-2 w-full rounded-[11px] bg-[#4fe89a] p-[14px] text-[15px] font-bold text-[#0e1a13] shadow-[0_0_20px_rgba(79,232,154,.3)] transition hover:brightness-110 disabled:opacity-50"
  >
    {busy ? pending : idle}
  </button>
);
