import type { FC } from "react";

// Closing call-to-action — scanlines + glow over a centered "Start the party."
// with anchors back to the hero form (#join) and how-it-works (#how).
export const LandingCta: FC = () => (
  <section
    style={{ position: "relative", overflow: "hidden", borderBottom: "1px solid var(--divider)" }}
  >
    <div
      className="cp-scan"
      style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 2, opacity: 0.4 }}
    />
    <div
      style={{
        position: "absolute",
        bottom: -200,
        left: "50%",
        transform: "translateX(-50%)",
        width: 640,
        height: 440,
        background: "radial-gradient(circle,var(--glow),transparent 66%)",
        pointerEvents: "none",
        zIndex: 1,
      }}
    />
    <div
      style={{
        position: "relative",
        zIndex: 3,
        maxWidth: 1120,
        margin: "0 auto",
        padding: "96px 40px",
        textAlign: "center",
      }}
    >
      <div
        style={{ fontSize: 11, color: "var(--accent)", letterSpacing: ".16em", marginBottom: 18 }}
      >
        $ ready when your team is
      </div>
      <h2
        style={{
          margin: "0 auto",
          fontSize: 44,
          fontWeight: 800,
          letterSpacing: "-.025em",
          maxWidth: "16ch",
          lineHeight: 1.05,
        }}
      >
        Start the party.
      </h2>
      <p
        style={{
          margin: "20px auto 0",
          fontSize: 15,
          lineHeight: 1.7,
          color: "var(--muted)",
          maxWidth: "48ch",
        }}
      >
        Spin up a session, share the link, and pair with Claude as a team — everything live,
        everything reviewed.
      </p>
      <div
        style={{
          display: "flex",
          gap: 14,
          justifyContent: "center",
          marginTop: 32,
          flexWrap: "wrap",
        }}
      >
        <a
          className="cp-btn"
          href="#join"
          style={{
            background: "var(--accent)",
            color: "var(--on-accent)",
            fontWeight: 700,
            padding: "14px 26px",
            borderRadius: 8,
            fontSize: 14,
          }}
        >
          ▚ start a session
        </a>
        <a
          className="cp-btn"
          href="#how"
          style={{
            border: "1px solid var(--accent-border)",
            color: "var(--accent-2)",
            padding: "14px 26px",
            borderRadius: 8,
            fontSize: 14,
            background: "var(--surface-3)",
          }}
        >
          see how it works
        </a>
      </div>
    </div>
  </section>
);
