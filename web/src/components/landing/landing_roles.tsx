import type { CSSProperties, FC } from "react";

// Mirrors the server-enforced permission matrix — the source of truth is
// SessionPolicy::MATRIX (api/app/policies/session_policy.rb). Columns map to the
// real action symbols: run, interrupt, approve (pairs with reject), manage_session
// ("change dir"), manage_invites ("invite"), chat. view is universal (omitted);
// bypass_permissions is an owner-only advanced mode (omitted). manage_tasks is
// omitted — the task board is not in the MVP, so it isn't advertised here. approve
// is what distinguishes reviewer from viewer.
const COLS = ["run", "interrupt", "approve", "change dir", "invite", "chat"] as const;

interface Role {
  name: string;
  blurb: string;
  // allowed[i] maps to COLS[i]
  allowed: boolean[];
  owner?: boolean;
}

const ROLES: Role[] = [
  {
    name: "owner",
    blurb: "full control",
    owner: true,
    allowed: [true, true, true, true, true, true],
  },
  {
    name: "editor",
    blurb: "drives Claude + approves",
    allowed: [true, true, true, false, false, true],
  },
  {
    name: "reviewer",
    blurb: "reviews + approves",
    allowed: [false, false, true, false, false, true],
  },
  {
    name: "viewer",
    blurb: "watches + chats",
    allowed: [false, false, false, false, false, true],
  },
];

const GRID = "1.1fr .8fr .8fr .9fr .9fr .8fr .7fr";

const cell: CSSProperties = { textAlign: "center" };

// "02 · Roles" — the invite-link permission matrix. Server-enforced; the client
// only hides what a role can't do.
export const LandingRoles: FC = () => (
  <section
    id="roles"
    style={{
      borderBottom: "1px solid var(--divider)",
      background: "var(--bg-alt)",
      scrollMarginTop: 70,
    }}
  >
    <div className="cp-wrap">
      <div
        style={{ fontSize: 11, color: "var(--accent)", letterSpacing: ".16em", marginBottom: 16 }}
      >
        02 · ROLES
      </div>
      <h2
        style={{
          margin: 0,
          fontSize: 34,
          fontWeight: 800,
          letterSpacing: "-.02em",
          maxWidth: "24ch",
        }}
      >
        Invite links, scoped to a role.
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
        Mint a link for exactly the access you want to grant. The server enforces every action — the
        UI just hides what a role can't do.
      </p>

      <div
        className="cp-scrollx"
        style={{
          marginTop: 40,
          border: "1px solid var(--border)",
          borderRadius: 11,
          overflow: "hidden",
          background: "var(--surface)",
        }}
      >
        {/* header */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: GRID,
            fontSize: 11,
            background: "var(--surface-2)",
            borderBottom: "1px solid var(--divider)",
            color: "var(--muted-2)",
            minWidth: 640,
          }}
        >
          <div style={{ padding: "13px 16px", color: "var(--text)", fontWeight: 700 }}>role</div>
          {COLS.map((c) => (
            <div key={c} style={{ padding: "13px 8px", textAlign: "center" }}>
              {c}
            </div>
          ))}
        </div>
        {/* rows */}
        {ROLES.map((role, ri) => (
          <div
            key={role.name}
            style={{
              display: "grid",
              gridTemplateColumns: GRID,
              fontSize: 12,
              borderBottom: ri < ROLES.length - 1 ? "1px solid var(--divider-2)" : "none",
              alignItems: "center",
              minWidth: 640,
            }}
          >
            <div style={{ padding: "15px 16px" }}>
              <span
                style={{ color: role.owner ? "var(--accent)" : "var(--text)", fontWeight: 700 }}
              >
                {role.name}
              </span>
              <div style={{ color: "var(--muted-3)", fontSize: 10.5, marginTop: 3 }}>
                {role.blurb}
              </div>
            </div>
            {role.allowed.map((ok, ci) => (
              <div key={COLS[ci]} style={{ ...cell, color: ok ? "var(--accent)" : "var(--faint)" }}>
                {ok ? "●" : "·"}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 14, fontSize: 11.5, color: "var(--muted-3)" }}>
        <span style={{ color: "var(--accent)" }}>●</span> allowed&nbsp;&nbsp;&nbsp;
        <span style={{ color: "var(--faint)" }}>·</span> not permitted&nbsp;&nbsp;&nbsp;— enforced
        server-side on every request
      </div>
    </div>
  </section>
);
