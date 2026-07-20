import type { FC } from "react";

const PRODUCT: { label: string; href: string }[] = [
  { label: "how it works", href: "#how" },
  { label: "roles", href: "#roles" },
  { label: "security", href: "#security" },
];

const GET_STARTED: { label: string; href: string }[] = [
  { label: "join a session", href: "#join" },
  { label: "create a session", href: "#join" },
];

const BADGES = ["Rails 8", "ActionCable", "Fastify sidecar", "React 19"];

export const LandingFooter: FC = () => (
  <footer style={{ maxWidth: 1120, margin: "0 auto", padding: "52px 40px 60px" }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: 40, flexWrap: "wrap" }}>
      <div style={{ maxWidth: "34ch" }}>
        <div
          style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 800, fontSize: 15 }}
        >
          <span style={{ color: "var(--accent)" }}>▚</span>clawdparty
        </div>
        <p
          style={{ margin: "14px 0 0", fontSize: 12.5, lineHeight: 1.65, color: "var(--muted-2)" }}
        >
          Real-time collaborative Claude Code sessions in your browser. One host, one worktree, one
          team.
        </p>
      </div>
      <div style={{ display: "flex", gap: 56, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 11, fontSize: 12.5 }}>
          <span style={{ color: "var(--muted-4)", fontSize: 10.5, letterSpacing: ".1em" }}>
            PRODUCT
          </span>
          {PRODUCT.map((l) => (
            <a key={l.label} className="cp-navlink" href={l.href}>
              {l.label}
            </a>
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 11, fontSize: 12.5 }}>
          <span style={{ color: "var(--muted-4)", fontSize: 10.5, letterSpacing: ".1em" }}>
            GET STARTED
          </span>
          {GET_STARTED.map((l) => (
            <a key={l.label} className="cp-navlink" href={l.href}>
              {l.label}
            </a>
          ))}
        </div>
      </div>
    </div>
    <div
      style={{
        marginTop: 44,
        paddingTop: 22,
        borderTop: "1px solid var(--divider)",
        display: "flex",
        justifyContent: "space-between",
        gap: 20,
        flexWrap: "wrap",
        alignItems: "center",
      }}
    >
      <span style={{ fontSize: 11.5, color: "var(--muted-4)" }}>
        LAN-only MVP · your main checkout is never touched
      </span>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {BADGES.map((b) => (
          <span
            key={b}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 5,
              padding: "4px 9px",
              fontSize: 10.5,
              color: "var(--muted-2)",
            }}
          >
            {b}
          </span>
        ))}
      </div>
    </div>
  </footer>
);
