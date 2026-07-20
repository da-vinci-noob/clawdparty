import type { CSSProperties, FC } from "react";

interface Step {
  n: string;
  chip: string;
  body: string;
}

const STEPS: Step[] = [
  {
    n: "01",
    chip: "$ bin/start",
    body: "One Mac boots the whole stack — Rails, the Claude sidecar, jobs, and Postgres — under Docker Compose.",
  },
  {
    n: "02",
    chip: "share invite ↗",
    body: "Mint a role-scoped link. Teammates open it, pick a display name, and land in the same live session.",
  },
  {
    n: "03",
    chip: "▚ drive together",
    body: "Prompt, watch it stream, chat, interrupt, and review every diff together before anything is committed.",
  },
];

const STACK = [
  "rails · puma :3000",
  "sidecar · claude sdk",
  "jobs · solid queue",
  "postgres",
  "git worktrees",
];

interface Peer {
  name: string;
  role: string;
  host: string;
  owner?: boolean;
}

const PEERS: Peer[] = [
  { name: "owner", role: "runs · approves", host: "host.local", owner: true },
  { name: "alice", role: "editor", host: "·local" },
  { name: "bob", role: "reviewer", host: "·local" },
  { name: "dana", role: "viewer", host: "·local" },
];

const chip: CSSProperties = {
  display: "inline-block",
  border: "1px solid var(--accent-border)",
  background: "var(--accent-bg)",
  color: "var(--accent-2)",
  borderRadius: 6,
  padding: "5px 10px",
  fontSize: 12,
  marginBottom: 14,
};

const smallDot: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: "50%",
  background: "#3a4440",
  display: "inline-block",
};

// "01 · How it works" — the boot-share-drive steps plus a host-Mac architecture
// diagram (services on one machine, browsers on the same LAN).
export const LandingHowItWorks: FC = () => (
  <section id="how" style={{ borderBottom: "1px solid var(--divider)", scrollMarginTop: 70 }}>
    <div className="cp-wrap">
      <div
        style={{ fontSize: 11, color: "var(--accent)", letterSpacing: ".16em", marginBottom: 16 }}
      >
        01 · HOW IT WORKS
      </div>
      <h2
        style={{
          margin: 0,
          fontSize: 34,
          fontWeight: 800,
          letterSpacing: "-.02em",
          maxWidth: "20ch",
        }}
      >
        One Mac hosts. Everyone drives.
      </h2>
      <p
        style={{
          margin: "16px 0 0",
          fontSize: 14.5,
          lineHeight: 1.7,
          color: "var(--muted)",
          maxWidth: "60ch",
        }}
      >
        clawdparty runs on a single machine under Docker Compose. Teammates join from any browser on
        your network — no terminal, no local setup, no screen-share.
      </p>

      <div className="cp-3col" style={{ marginTop: 44 }}>
        {STEPS.map((s) => (
          <div
            key={s.n}
            className="cp-card"
            style={{
              border: "1px solid var(--border)",
              borderRadius: 10,
              background: "var(--surface)",
              padding: 22,
            }}
          >
            <div style={{ color: "var(--accent)", fontSize: 12, marginBottom: 12 }}>{s.n}</div>
            <div style={chip}>{s.chip}</div>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.65, color: "var(--text-3)" }}>
              {s.body}
            </p>
          </div>
        ))}
      </div>

      {/* architecture diagram */}
      <div
        style={{
          marginTop: 26,
          border: "1px dashed var(--accent-border)",
          borderRadius: 12,
          padding: "30px 26px",
          background: "var(--bg-alt)",
        }}
      >
        <div
          style={{
            border: "1px solid var(--accent-border)",
            borderRadius: 9,
            background: "var(--surface-2)",
            padding: "18px 20px",
            maxWidth: 660,
            margin: "0 auto",
          }}
        >
          <div
            style={{
              color: "var(--accent)",
              fontWeight: 700,
              fontSize: 12,
              marginBottom: 14,
              letterSpacing: ".02em",
            }}
          >
            ▚ HOST MAC · docker compose · one machine
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
            {STACK.map((s) => (
              <span
                key={s}
                style={{
                  border: "1px solid var(--accent-border)",
                  borderRadius: 5,
                  padding: "5px 10px",
                  fontSize: 11,
                  color: "var(--accent-2)",
                  background: "var(--accent-bg)",
                }}
              >
                {s}
              </span>
            ))}
          </div>
        </div>
        <div
          style={{
            textAlign: "center",
            color: "var(--accent-deep)",
            fontSize: 11,
            margin: "16px 0",
            letterSpacing: ".14em",
          }}
        >
          └──────── same LAN · http://host.local:3000 ────────┘
        </div>
        <div className="cp-4col">
          {PEERS.map((p) => (
            <div
              key={p.name}
              className="cp-card"
              style={{
                border: `1px solid ${p.owner ? "var(--accent-border-2)" : "var(--border)"}`,
                borderRadius: 8,
                background: p.owner ? "var(--surface-3)" : "var(--surface)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "8px 10px",
                  borderBottom: "1px solid var(--divider)",
                }}
              >
                <span style={smallDot} />
                <span style={smallDot} />
                <span style={{ fontSize: 9, color: "var(--muted-4)", marginLeft: 4 }}>
                  {p.host}
                </span>
              </div>
              <div
                style={{
                  padding: 13,
                  textAlign: "center",
                  fontSize: 12,
                  color: p.owner ? "var(--accent)" : "var(--text-2b)",
                  fontWeight: p.owner ? 700 : 400,
                }}
              >
                {p.name}
                <br />
                <span style={{ color: "var(--muted-3)", fontWeight: 400, fontSize: 11 }}>
                  {p.role}
                </span>
              </div>
            </div>
          ))}
        </div>
        <p
          style={{
            textAlign: "center",
            margin: "20px 0 0",
            fontSize: 12,
            color: "var(--muted-2)",
            lineHeight: 1.6,
          }}
        >
          Everything Claude does lands uncommitted in a per-session git worktree — your main
          checkout is never touched.
        </p>
      </div>
    </div>
  </section>
);
