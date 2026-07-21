import type { CSSProperties, FC } from "react";
import { Link } from "react-router-dom";

type Theme = "dark" | "light";

const linkBox: CSSProperties = { fontSize: 12.5 };

// Sticky translucent nav: wordmark, section anchors, a light/dark toggle, a
// "live" pulse, and the primary "start a session" CTA (anchors to the hero form
// at #join). The section links collapse on narrow screens (cp-navlinks-extra).
export const LandingNav: FC<{ theme: Theme; onToggleTheme: () => void }> = ({
  theme,
  onToggleTheme,
}) => (
  <nav
    style={{
      position: "sticky",
      top: 0,
      zIndex: 20,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "16px 40px",
      background: "var(--nav-bg)",
      backdropFilter: "blur(9px)",
      WebkitBackdropFilter: "blur(9px)",
      borderBottom: "1px solid var(--divider)",
    }}
  >
    <a
      href="#top"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontWeight: 800,
        fontSize: 15,
        color: "var(--text)",
        letterSpacing: ".01em",
      }}
    >
      <span style={{ color: "var(--accent)" }}>▚</span>clawdparty
    </a>
    <div style={{ display: "flex", gap: 26, alignItems: "center", ...linkBox }}>
      <Link className="cp-navlink" to="/sessions">
        sessions
      </Link>
      <a className="cp-navlink cp-navlinks-extra" href="#preview">
        the session
      </a>
      <a className="cp-navlink cp-navlinks-extra" href="#how">
        how it works
      </a>
      <a className="cp-navlink cp-navlinks-extra" href="#roles">
        roles
      </a>
      <a className="cp-navlink cp-navlinks-extra" href="#security">
        security
      </a>
      <button
        type="button"
        onClick={onToggleTheme}
        aria-label="Toggle light or dark mode"
        className="cp-btn"
        style={{
          background: "none",
          border: "1px solid var(--border)",
          color: "var(--muted)",
          borderRadius: 7,
          width: 32,
          height: 32,
          cursor: "pointer",
          fontFamily: "inherit",
          fontSize: 14,
          lineHeight: 1,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {theme === "light" ? "☾" : "☀"}
      </button>
      <span
        style={{ color: "var(--accent)", display: "inline-flex", alignItems: "center", gap: 7 }}
      >
        <span
          className="cp-blink"
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: "var(--accent)",
            display: "inline-block",
          }}
        />
        live
      </span>
      <a
        className="cp-btn"
        href="#join"
        style={{
          background: "var(--accent)",
          color: "var(--on-accent)",
          fontWeight: 700,
          padding: "8px 15px",
          borderRadius: 7,
          fontSize: 12.5,
        }}
      >
        start a session
      </a>
    </div>
  </nav>
);
