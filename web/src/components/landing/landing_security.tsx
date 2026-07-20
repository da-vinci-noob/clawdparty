import type { FC } from "react";

interface Guard {
  title: string;
  body: string;
}

const GUARDS: Guard[] = [
  {
    title: "Signed-cookie auth",
    body: "Every endpoint requires a valid invite-token-derived, signed httpOnly cookie. No token, no access.",
  },
  {
    title: "Server-enforced roles",
    body: "Roles are checked on the server for every action. The UI only hides what a role can't do — it never gates it.",
  },
  {
    title: "Isolated worktree",
    body: "Claude is pinned to a per-session git worktree. Your main checkout is never touched.",
  },
  {
    title: "Human review gate",
    body: "Every changeset lands uncommitted behind an explicit approve / reject. Nothing merges on its own.",
  },
  {
    title: "Unpublished sidecar",
    body: "The process that talks to the Claude SDK is reachable only on the private compose network — never the LAN.",
  },
  {
    title: "Traversal + secret defense",
    body: "The file API defends against path traversal and denylists secrets before anything is served.",
  },
];

// "03 · Security" — LAN-only perimeter with defense-in-depth guards, one card each.
export const LandingSecurity: FC = () => (
  <section id="security" style={{ borderBottom: "1px solid var(--divider)", scrollMarginTop: 70 }}>
    <div className="cp-wrap">
      <div
        style={{ fontSize: 11, color: "var(--accent)", letterSpacing: ".16em", marginBottom: 16 }}
      >
        03 · SECURITY
      </div>
      <h2
        style={{
          margin: 0,
          fontSize: 34,
          fontWeight: 800,
          letterSpacing: "-.02em",
          maxWidth: "26ch",
        }}
      >
        The network is the perimeter. Everything else is defense in depth.
      </h2>
      <p
        style={{
          margin: "16px 0 0",
          fontSize: 14.5,
          lineHeight: 1.7,
          color: "var(--muted)",
          maxWidth: "62ch",
        }}
      >
        clawdparty is LAN-only for now — the trusted local network is the boundary. Even so, every
        layer assumes the worst.
      </p>

      <div className="cp-3col" style={{ marginTop: 42, gap: 16 }}>
        {GUARDS.map((g) => (
          <div
            key={g.title}
            className="cp-card"
            style={{
              border: "1px solid var(--border)",
              borderRadius: 10,
              background: "var(--surface)",
              padding: 22,
            }}
          >
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 26,
                height: 26,
                border: "1px solid var(--accent-border)",
                borderRadius: 6,
                color: "var(--accent)",
                fontSize: 13,
                marginBottom: 14,
              }}
            >
              ✓
            </div>
            <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 8 }}>{g.title}</div>
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6, color: "var(--muted)" }}>
              {g.body}
            </p>
          </div>
        ))}
      </div>
    </div>
  </section>
);
