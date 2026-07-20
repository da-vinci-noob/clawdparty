import {
  type CSSProperties,
  type FC,
  type FormEvent,
  type MouseEvent,
  useEffect,
  useState,
} from "react";

type Mode = "join" | "create";
type SessionMode = "review" | "chat";

// The hero's join/create form state + handlers, owned by the page (so the
// submit logic stays testable) and threaded down here for rendering.
export interface HeroForm {
  tab: Mode;
  token: string;
  name: string;
  title: string;
  mode: SessionMode;
  directory: string;
  busy: boolean;
  error: string | null;
  setTab: (t: Mode) => void;
  setToken: (v: string) => void;
  setName: (v: string) => void;
  setTitle: (v: string) => void;
  setMode: (v: SessionMode) => void;
  setDirectory: (v: string) => void;
  onSubmit: (e: FormEvent) => void;
}

const HERO_PROMPT = "> claude, refactor the auth middleware";

const inputStyle: CSSProperties = {
  width: "100%",
  background: "var(--input-bg)",
  border: "1px solid var(--border-2)",
  borderRadius: 8,
  padding: 13,
  color: "var(--text)",
  fontFamily: "inherit",
  fontSize: 13.5,
  marginBottom: 10,
  outline: "none",
};

// Both tabs stay at --text-2; the active tab is signalled only by the accent
// underline (activeBar), matching the design.
const tabStyle: CSSProperties = {
  position: "relative",
  padding: "0 0 11px",
  background: "none",
  border: "none",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 13.5,
  fontWeight: 700,
  color: "var(--text-2)",
};

const activeBar: CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: -1,
  height: 2,
  background: "var(--accent)",
};

const Avatar: FC<{ initials: string; style: CSSProperties }> = ({ initials, style }) => (
  <span
    className="cp-avatar"
    style={{
      width: 30,
      height: 30,
      borderRadius: "50%",
      border: "2px solid var(--bg)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: 11,
      fontWeight: 700,
      ...style,
    }}
  >
    {initials}
  </span>
);

const StatCard: FC<{ label: string; sub: string }> = ({ label, sub }) => (
  <div
    className="cp-stat"
    style={{
      border: "1px solid var(--border)",
      borderRadius: 9,
      background: "var(--surface)",
      padding: "12px 13px",
    }}
  >
    <div style={{ fontSize: 12, color: "var(--text)", fontWeight: 700 }}>
      <span style={{ color: "var(--accent)" }}>✓</span> {label}
    </div>
    <div style={{ fontSize: 10.5, color: "var(--muted-3)", marginTop: 3 }}>{sub}</div>
  </div>
);

// Hero: eyebrow pill + headline + subcopy + presence + stat row + the join/create
// form on the left; a mouse-tilt terminal mockup that types the prompt and then
// fades in a live run → changeset flow on the right.
export const LandingHero: FC<{ form: HeroForm }> = ({ form }) => {
  const [typed, setTyped] = useState("");
  const [tilt, setTilt] = useState({ rx: 0, ry: 0 });

  useEffect(() => {
    // Honor reduced-motion: show the full prompt at once instead of typing it.
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setTyped(HERO_PROMPT);
      return;
    }
    const id = setInterval(() => {
      setTyped((prev) => {
        if (prev.length >= HERO_PROMPT.length) {
          clearInterval(id);
          return prev;
        }
        return HERO_PROMPT.slice(0, prev.length + 1);
      });
    }, 55);
    return () => clearInterval(id);
  }, []);

  const onTilt = (e: MouseEvent<HTMLDivElement>): void => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    setTilt({ rx: -py * 11, ry: px * 13 });
  };

  const isJoin = form.tab === "join";
  const submitLabel = isJoin
    ? form.busy
      ? "joining…"
      : "join session"
    : form.busy
      ? "creating…"
      : "create session";

  return (
    <header
      style={{
        position: "relative",
        overflow: "hidden",
        borderBottom: "1px solid var(--divider)",
      }}
    >
      <div
        className="cp-scan"
        style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 2, opacity: 0.45 }}
      />
      <div
        style={{
          position: "absolute",
          top: -180,
          right: -100,
          width: 520,
          height: 520,
          background: "radial-gradient(circle,var(--glow),transparent 68%)",
          pointerEvents: "none",
          zIndex: 1,
        }}
      />
      <div className="cp-hero-grid" style={{ position: "relative", zIndex: 3 }}>
        {/* LEFT — copy + form */}
        <div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 9,
              border: "1px solid var(--accent-border)",
              background: "var(--accent-bg)",
              borderRadius: 999,
              padding: "5px 13px 5px 9px",
              fontSize: 10.5,
              letterSpacing: ".14em",
              color: "var(--accent-2)",
              marginBottom: 24,
            }}
          >
            <span
              className="cp-blink"
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--accent)",
                display: "inline-block",
              }}
            />
            REAL-TIME COLLAB FOR CLAUDE CODE
          </div>
          <h1
            style={{
              margin: 0,
              fontSize: 56,
              lineHeight: 1.02,
              fontWeight: 800,
              letterSpacing: "-.028em",
            }}
          >
            One{" "}
            <span style={{ position: "relative", display: "inline-block", color: "var(--accent)" }}>
              Clawd
              <span
                className="cp-glow"
                style={{
                  position: "absolute",
                  left: "-8%",
                  right: "-8%",
                  bottom: 6,
                  height: 14,
                  background: "var(--glow)",
                  filter: "blur(9px)",
                  zIndex: -1,
                  borderRadius: 8,
                }}
              />
            </span>
            .<br />
            The whole room.
          </h1>
          <p
            style={{
              margin: "24px 0 0",
              fontSize: 15.5,
              lineHeight: 1.7,
              color: "var(--muted)",
              maxWidth: "42ch",
            }}
          >
            Turn a single Claude Code session into a shared room. Your team watches it think,
            stream, and ship — live in the browser. Nobody touches a terminal.
          </p>

          <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 28 }}>
            <div style={{ display: "flex" }}>
              <Avatar
                initials="O"
                style={{
                  background: "linear-gradient(135deg,var(--accent-deep),var(--accent))",
                  color: "var(--on-accent)",
                }}
              />
              <Avatar
                initials="A"
                style={{
                  backgroundColor: "var(--accent-bg-2)",
                  color: "var(--accent-2)",
                  marginLeft: -9,
                }}
              />
              <Avatar
                initials="B"
                style={{ backgroundColor: "#1a2a3a", color: "#8fbde0", marginLeft: -9 }}
              />
              <Avatar
                initials="D"
                style={{ backgroundColor: "#2a2033", color: "#c9a6e0", marginLeft: -9 }}
              />
            </div>
            <span style={{ fontSize: 12, color: "var(--muted-2)" }}>
              4 in the room, watching it work
            </span>
          </div>

          <div className="cp-3col" style={{ marginTop: 24, maxWidth: 440, gap: 10 }}>
            <StatCard label="stream live" sub="token-by-token" />
            <StatCard label="review diffs" sub="approve / reject" />
            <StatCard label="late join" sub="gap-free replay" />
          </div>

          <form
            id="join"
            data-testid={isJoin ? "join-form" : "create-form"}
            onSubmit={form.onSubmit}
            style={{ marginTop: 34, maxWidth: 440, scrollMarginTop: 90 }}
          >
            <div
              data-testid="landing-mode-toggle"
              style={{
                display: "flex",
                gap: 26,
                borderBottom: "1px solid var(--border)",
                marginBottom: 18,
              }}
            >
              <button type="button" onClick={() => form.setTab("join")} style={tabStyle}>
                join
                {isJoin && <span style={activeBar} />}
              </button>
              <button type="button" onClick={() => form.setTab("create")} style={tabStyle}>
                create
                {!isJoin && <span style={activeBar} />}
              </button>
            </div>

            {isJoin ? (
              <>
                <input
                  className="cp-a"
                  aria-label="Invite token"
                  placeholder="invite token"
                  value={form.token}
                  onChange={(e) => form.setToken(e.target.value)}
                  style={inputStyle}
                />
                <input
                  className="cp-a"
                  aria-label="Display name"
                  placeholder="display name"
                  value={form.name}
                  onChange={(e) => form.setName(e.target.value)}
                  style={inputStyle}
                />
              </>
            ) : (
              <>
                <input
                  className="cp-a"
                  aria-label="Session title"
                  placeholder="session title"
                  value={form.title}
                  onChange={(e) => form.setTitle(e.target.value)}
                  style={inputStyle}
                />
                <input
                  className="cp-a"
                  aria-label="Display name"
                  placeholder="display name"
                  value={form.name}
                  onChange={(e) => form.setName(e.target.value)}
                  style={inputStyle}
                />
                <select
                  className="cp-a"
                  aria-label="Session mode"
                  value={form.mode}
                  onChange={(e) => form.setMode(e.target.value as SessionMode)}
                  style={inputStyle}
                >
                  <option value="review">review — git diff + approve/reject</option>
                  <option value="chat">chat — run in a directory, no git</option>
                </select>
                <input
                  className="cp-a"
                  aria-label="Working directory"
                  placeholder="~/dev/my-repo  (working directory)"
                  value={form.directory}
                  onChange={(e) => form.setDirectory(e.target.value)}
                  style={inputStyle}
                />
              </>
            )}

            <button
              className="cp-btn"
              type="submit"
              disabled={form.busy}
              style={{
                width: "100%",
                marginTop: 4,
                background: "var(--accent)",
                color: "var(--on-accent)",
                border: "none",
                borderRadius: 8,
                padding: 14,
                fontFamily: "inherit",
                fontSize: 14,
                fontWeight: 700,
                cursor: form.busy ? "default" : "pointer",
                opacity: form.busy ? 0.7 : 1,
              }}
            >
              {submitLabel}
            </button>
            {form.error && (
              <p
                data-testid="join-error"
                role="alert"
                style={{ color: "#f87171", fontSize: 12, margin: "11px 0 0" }}
              >
                {form.error}
              </p>
            )}
          </form>
        </div>

        {/* RIGHT — tilt terminal mockup */}
        <div className="cp-tiltwrap">
          <div
            className="cp-tilt"
            onMouseMove={onTilt}
            onMouseLeave={() => setTilt({ rx: 0, ry: 0 })}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 12,
              background: "var(--surface)",
              overflow: "hidden",
              boxShadow: "0 26px 50px -20px var(--shadow)",
              transform: `rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg)`,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "12px 15px",
                borderBottom: "1px solid var(--divider)",
              }}
            >
              <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#ff5f56" }} />
              <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#ffbd2e" }} />
              <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#27c93f" }} />
              <span style={{ marginLeft: 8, fontSize: 11.5, color: "var(--muted-2)" }}>
                session · clawd/auth-refactor · 3 online
              </span>
            </div>
            <div
              style={{ padding: "19px 19px 24px", fontSize: 13, lineHeight: 1.8, minHeight: 330 }}
            >
              <div>
                <span style={{ color: "var(--accent)" }}>➜</span> <span>{typed}</span>
                <span className="cp-blink" style={{ color: "var(--accent)" }}>
                  ▋
                </span>
              </div>
              <div
                className="cp-fadeup"
                style={{ animationDelay: "2.3s", color: "var(--muted-3)", marginTop: 14 }}
              >
                ● thinking — mapping callers of{" "}
                <span style={{ color: "#8a938a" }}>requireAuth</span> …
              </div>
              <div
                className="cp-fadeup"
                style={{ animationDelay: "3s", marginTop: 9, color: "var(--text-2)" }}
              >
                Splitting <span style={{ color: "var(--accent)" }}>requireAuth</span> into a guard +
                a policy check. Updating 3 call sites.
              </div>
              <div
                className="cp-fadeup"
                style={{
                  animationDelay: "3.7s",
                  marginTop: 14,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  border: "1px solid var(--accent-border)",
                  borderRadius: 6,
                  padding: "6px 10px",
                  background: "var(--accent-bg)",
                  color: "var(--accent-2)",
                  fontSize: 12,
                }}
              >
                ⚙ Edit · api/app/middleware/auth.rb
              </div>
              <div
                className="cp-fadeup"
                style={{
                  animationDelay: "4.4s",
                  marginTop: 14,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  fontSize: 12,
                }}
              >
                <span
                  style={{
                    background: "var(--border-2)",
                    color: "var(--accent)",
                    borderRadius: 4,
                    padding: "1px 7px",
                    fontWeight: 700,
                  }}
                >
                  M
                </span>
                <span style={{ color: "var(--text-3)" }}>api/app/middleware/auth.rb</span>
                <span style={{ color: "var(--accent)" }}>+18</span>
                <span style={{ color: "#f87171" }}>−7</span>
              </div>
              <div
                className="cp-fadeup"
                style={{
                  animationDelay: "5.2s",
                  marginTop: 18,
                  borderTop: "1px solid var(--divider)",
                  paddingTop: 16,
                  color: "var(--accent)",
                }}
              >
                ✓ changeset ready — awaiting review
                <span className="cp-blink">▋</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
};
