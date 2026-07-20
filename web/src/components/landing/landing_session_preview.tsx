import { type CSSProperties, type FC, useEffect, useState } from "react";

// Claude's playful "working…" verbs, cycled in the transcript to mimic the live
// streaming status line.
const WORK_WORDS = [
  "Razzmatazzing",
  "Percolating",
  "Conjuring",
  "Noodling",
  "Finagling",
  "Frolicking",
  "Marinating",
  "Tinkering",
  "Scheming",
  "Bamboozling",
];

const dot = (bg: string, size = 11): CSSProperties => ({
  width: size,
  height: size,
  borderRadius: "50%",
  background: bg,
  display: "inline-block",
});

const avatar = (bg: string, color: string, size = 22): CSSProperties => ({
  width: size,
  height: size,
  flex: `0 0 ${size}px`,
  borderRadius: "50%",
  background: bg,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: size >= 24 ? 10 : 10,
  fontWeight: 700,
  color,
});

const pill: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  border: "1px solid var(--border-2)",
  borderRadius: 6,
  padding: "6px 10px",
  fontSize: 11,
  color: "var(--text-2b)",
};

// A session-history row in the left pane.
const SessionRow: FC<{
  name: string;
  dotColor: string;
  nameColor: string;
  badge: { text: string; filled?: boolean; outline?: boolean };
  meta: string;
  metaColor: string;
}> = ({ name, dotColor, nameColor, badge, meta, metaColor }) => (
  <div className="cp-msg" style={{ padding: "8px 10px", borderRadius: 8 }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          fontSize: 12,
          color: nameColor,
          fontWeight: 700,
        }}
      >
        <span style={dot(dotColor, 6)} />
        {name}
      </span>
      <span
        style={{
          fontSize: 8.5,
          fontWeight: 700,
          letterSpacing: ".08em",
          ...(badge.filled
            ? {
                color: "var(--on-accent)",
                background: "var(--accent)",
                borderRadius: 4,
                padding: "2px 5px",
              }
            : badge.outline
              ? {
                  color: "var(--accent)",
                  border: "1px solid var(--accent-border)",
                  borderRadius: 4,
                  padding: "1px 5px",
                }
              : {
                  color: "var(--muted-3)",
                  border: "1px solid var(--border-2)",
                  borderRadius: 4,
                  padding: "1px 5px",
                }),
        }}
      >
        {badge.text}
      </span>
    </div>
    <div style={{ fontSize: 10, color: metaColor, marginTop: 4, paddingLeft: 13 }}>{meta}</div>
  </div>
);

// "Inside a session" — a static, faithful mock of the 3-pane session workspace:
// your session history (left), Claude's live transcript + a rich composer with a
// context-window meter and model/skills controls (center), and the room chat
// (right).
export const LandingSessionPreview: FC = () => {
  const [workIdx, setWorkIdx] = useState(0);

  useEffect(() => {
    // Honor reduced-motion: leave the status word static.
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const id = setInterval(() => {
      setWorkIdx((prev) => (prev + 1) % WORK_WORDS.length);
    }, 1900);
    return () => clearInterval(id);
  }, []);

  return (
    <section
      id="preview"
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
          ▚ INSIDE A SESSION
        </div>
        <h2
          style={{
            margin: 0,
            fontSize: 34,
            fontWeight: 800,
            letterSpacing: "-.02em",
            maxWidth: "22ch",
          }}
        >
          This is what the room looks like.
        </h2>
        <p
          style={{
            margin: "16px 0 0",
            fontSize: 14.5,
            lineHeight: 1.7,
            color: "var(--muted)",
            maxWidth: "64ch",
          }}
        >
          Your sessions on the left, Claude streaming in the middle — with the model, skills, and a
          live context-window meter right in the composer — and the room chatting alongside on the
          right. Everyone sees the same thing, live.
        </p>

        <div
          className="cp-scrollx"
          style={{
            marginTop: 40,
            border: "1px solid var(--border)",
            borderRadius: 13,
            overflow: "hidden",
            background: "var(--bg2)",
            boxShadow: "0 30px 60px -24px var(--shadow)",
          }}
        >
          {/* top chrome */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "11px 16px",
              borderBottom: "1px solid var(--divider)",
              background: "var(--surface)",
              minWidth: 720,
            }}
          >
            <div style={{ display: "flex", gap: 7 }}>
              <span style={dot("#ff5f56")} />
              <span style={dot("#ffbd2e")} />
              <span style={dot("#27c93f")} />
            </div>
            <div
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                gap: 8,
                background: "var(--bg2)",
                border: "1px solid var(--divider)",
                borderRadius: 6,
                padding: "5px 11px",
                fontSize: 11,
                color: "var(--muted-2)",
                maxWidth: 360,
              }}
            >
              <span style={{ color: "var(--accent)" }}>▚</span>
              host.local:3000/sessions/auth-refactor
            </div>
          </div>

          {/* 3-pane body */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "212px 1fr 246px",
              minHeight: 460,
              minWidth: 720,
            }}
          >
            {/* LEFT: session history */}
            <div
              style={{
                borderRight: "1px solid var(--divider)",
                background: "var(--bg-alt)",
                padding: "14px 12px",
                display: "flex",
                flexDirection: "column",
                gap: 4,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 4,
                }}
              >
                <span style={{ fontSize: 10, color: "var(--muted-4)", letterSpacing: ".12em" }}>
                  YOUR SESSIONS
                </span>
                <span style={{ fontSize: 10, color: "var(--muted-4)" }}>4</span>
              </div>
              {/* active session (highlighted) */}
              <div
                style={{
                  padding: "8px 10px",
                  borderRadius: 8,
                  background: "var(--accent-bg)",
                  border: "1px solid var(--accent-border)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 6,
                  }}
                >
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      fontSize: 12,
                      color: "var(--text)",
                      fontWeight: 700,
                    }}
                  >
                    <span style={dot("var(--accent)", 6)} />
                    auth-refactor
                  </span>
                  <span
                    style={{
                      fontSize: 8.5,
                      fontWeight: 700,
                      letterSpacing: ".08em",
                      color: "var(--on-accent)",
                      background: "var(--accent)",
                      borderRadius: 4,
                      padding: "2px 5px",
                    }}
                  >
                    ACTIVE
                  </span>
                </div>
                <div
                  style={{ fontSize: 10, color: "var(--accent-2)", marginTop: 4, paddingLeft: 13 }}
                >
                  3 online · now
                </div>
              </div>
              <SessionRow
                name="redesign-onboarding"
                dotColor="var(--accent)"
                nameColor="var(--text-2b)"
                badge={{ text: "ACTIVE", outline: true }}
                meta="3 online · 12m"
                metaColor="var(--muted-3)"
              />
              <SessionRow
                name="billing-webhooks"
                dotColor="var(--muted-4)"
                nameColor="var(--text-2b)"
                badge={{ text: "REVOKED" }}
                meta="you · 2h"
                metaColor="var(--muted-3)"
              />
              <SessionRow
                name="search-reindex"
                dotColor="var(--muted-4)"
                nameColor="var(--text-2b)"
                badge={{ text: "REVOKED" }}
                meta="you · yesterday"
                metaColor="var(--muted-3)"
              />
              <div
                style={{ marginTop: "auto", borderTop: "1px solid var(--divider)", paddingTop: 11 }}
              >
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--muted-4)",
                    letterSpacing: ".1em",
                    marginBottom: 9,
                  }}
                >
                  IN THE ROOM · 3
                </div>
                <div style={{ display: "flex", alignItems: "center" }}>
                  <span
                    style={{
                      ...avatar(
                        "linear-gradient(135deg,var(--accent-deep),var(--accent))",
                        "var(--on-accent)",
                        24,
                      ),
                      border: "2px solid var(--bg-alt)",
                    }}
                  >
                    O
                  </span>
                  <span
                    style={{
                      ...avatar("var(--accent-bg-2)", "var(--accent-2)", 24),
                      border: "2px solid var(--bg-alt)",
                      marginLeft: -8,
                    }}
                  >
                    A
                  </span>
                  <span
                    style={{
                      ...avatar("#1a2a3a", "#8fbde0", 24),
                      border: "2px solid var(--bg-alt)",
                      marginLeft: -8,
                    }}
                  >
                    B
                  </span>
                  <span style={{ marginLeft: 10, fontSize: 10.5, color: "var(--muted-3)" }}>
                    olive, alice, bob
                  </span>
                </div>
              </div>
            </div>

            {/* CENTER: transcript + composer */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                borderRight: "1px solid var(--divider)",
              }}
            >
              <div
                style={{
                  flex: 1,
                  padding: "18px 20px",
                  fontSize: 12.5,
                  lineHeight: 1.7,
                  overflow: "hidden",
                }}
              >
                <div
                  className="cp-msg"
                  style={{
                    display: "flex",
                    gap: 9,
                    padding: "8px 9px",
                    borderRadius: 8,
                    transition: "background .15s",
                  }}
                >
                  <span style={avatar("var(--accent-bg-2)", "var(--accent-2)")}>A</span>
                  <div>
                    <span style={{ color: "var(--accent)", fontWeight: 700 }}>alice</span>{" "}
                    <span style={{ color: "var(--muted-4)", fontSize: 10 }}>2:14</span>
                    <div style={{ color: "var(--text-2)", marginTop: 2 }}>
                      claude, refactor the auth middleware — split the guard from the policy check.
                    </div>
                  </div>
                </div>
                <div
                  className="cp-msg"
                  style={{
                    display: "flex",
                    gap: 9,
                    padding: "8px 9px",
                    borderRadius: 8,
                    transition: "background .15s",
                    marginTop: 4,
                  }}
                >
                  <span
                    style={{
                      ...avatar(
                        "linear-gradient(135deg,var(--accent-deep),var(--accent))",
                        "var(--on-accent)",
                      ),
                      fontSize: 11,
                      fontWeight: 400,
                    }}
                  >
                    ▚
                  </span>
                  <div style={{ flex: 1 }}>
                    <span style={{ color: "var(--accent)", fontWeight: 700 }}>clawd</span>{" "}
                    <span style={{ color: "var(--muted-4)", fontSize: 10 }}>streaming</span>
                    <div style={{ color: "var(--muted-3)", marginTop: 4 }}>
                      ● thinking — mapping callers of{" "}
                      <span style={{ color: "#8a938a" }}>requireAuth</span> across 3 files…
                    </div>
                    <div style={{ color: "var(--text-2)", marginTop: 6 }}>
                      I'll pull the policy logic into{" "}
                      <span style={{ color: "var(--accent)" }}>AuthPolicy</span> and leave{" "}
                      <span style={{ color: "var(--accent)" }}>requireAuth</span> as a thin guard.
                      Updating the call sites now.
                    </div>
                    <div
                      style={{
                        marginTop: 9,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 8,
                        border: "1px solid var(--accent-border)",
                        borderRadius: 6,
                        padding: "5px 10px",
                        background: "var(--accent-bg)",
                        color: "var(--accent-2)",
                        fontSize: 11.5,
                      }}
                    >
                      ⚙ Edit · api/app/middleware/auth.rb
                    </div>
                    <div
                      style={{
                        color: "var(--accent)",
                        marginTop: 9,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <span
                        style={{
                          width: 17,
                          height: 17,
                          flex: "0 0 17px",
                          borderRadius: 5,
                          background: "linear-gradient(135deg,var(--accent-deep),var(--accent))",
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 9,
                          color: "var(--on-accent)",
                        }}
                      >
                        ▚
                      </span>
                      {WORK_WORDS[workIdx]}…<span className="cp-blink">▋</span>
                    </div>
                  </div>
                </div>
              </div>
              {/* composer */}
              <div
                style={{
                  borderTop: "1px solid var(--divider)",
                  padding: "12px 16px",
                  background: "var(--bg-alt)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    fontSize: 10,
                    marginBottom: 9,
                  }}
                >
                  <span style={{ letterSpacing: ".12em", color: "var(--muted-4)" }}>CONTEXT</span>
                  <span
                    style={{
                      flex: 1,
                      height: 5,
                      borderRadius: 3,
                      background: "var(--border-2)",
                      overflow: "hidden",
                      display: "block",
                    }}
                  >
                    <span
                      style={{
                        display: "block",
                        width: "62%",
                        height: "100%",
                        background: "var(--accent)",
                      }}
                    />
                  </span>
                  <span style={{ color: "var(--text-3)" }}>124K / 200K · 62%</span>
                </div>
                <div
                  style={{
                    background: "var(--input-bg)",
                    border: "1px solid var(--border-2)",
                    borderRadius: 8,
                    padding: "10px 12px",
                    fontSize: 12,
                    color: "var(--placeholder)",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <span style={{ color: "var(--accent)" }}>❯</span>message the room, or prompt
                  clawd…
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginTop: 9,
                    flexWrap: "wrap",
                  }}
                >
                  <span style={pill}>
                    <span style={dot("var(--accent)", 6)} />
                    claude-opus-4.8 <span style={{ color: "var(--muted-3)" }}>▾</span>
                  </span>
                  <span style={pill}>
                    + Skills{" "}
                    <span
                      style={{
                        background: "var(--accent-bg)",
                        color: "var(--accent)",
                        border: "1px solid var(--accent-border)",
                        borderRadius: 4,
                        padding: "0 6px",
                        fontWeight: 700,
                      }}
                    >
                      3
                    </span>
                  </span>
                  <span style={pill}>
                    Auto-accept <span style={{ color: "var(--muted-3)" }}>▾</span>
                  </span>
                  <span style={{ flex: 1 }} />
                  <span
                    className="cp-btn"
                    style={{
                      background: "var(--accent)",
                      color: "var(--on-accent)",
                      borderRadius: 6,
                      padding: "7px 15px",
                      fontSize: 11,
                      fontWeight: 700,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 7,
                    }}
                  >
                    Run <span style={{ opacity: 0.75 }}>⌘↵</span>
                  </span>
                </div>
              </div>
            </div>

            {/* RIGHT: room chat */}
            <div style={{ background: "var(--bg-alt)", display: "flex", flexDirection: "column" }}>
              <div
                style={{
                  padding: "13px 15px",
                  borderBottom: "1px solid var(--divider)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <span style={{ fontSize: 11, color: "var(--text)", fontWeight: 700 }}>
                  ROOM CHAT
                </span>
                <span
                  style={{
                    fontSize: 10,
                    color: "var(--accent)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <span className="cp-blink" style={dot("var(--accent)", 6)} />3 here
                </span>
              </div>
              <div
                style={{
                  flex: 1,
                  padding: "14px 15px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 13,
                  fontSize: 11.5,
                  overflow: "hidden",
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                    <span style={{ color: "#8fbde0", fontWeight: 700 }}>bob</span>
                    <span style={{ color: "var(--muted-4)", fontSize: 9 }}>2:13</span>
                  </div>
                  <div style={{ color: "var(--text-2)", marginTop: 3, lineHeight: 1.55 }}>
                    can we keep the policy check pure? easier to test
                  </div>
                </div>
                <div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                    <span style={{ color: "var(--accent)", fontWeight: 700 }}>olive</span>
                    <span style={{ color: "var(--muted-4)", fontSize: 9 }}>2:14</span>
                  </div>
                  <div style={{ color: "var(--text-2)", marginTop: 3, lineHeight: 1.55 }}>
                    +1 — approving as soon as the diff lands
                  </div>
                </div>
              </div>
              <div style={{ borderTop: "1px solid var(--divider)", padding: "11px 13px" }}>
                <div
                  style={{
                    background: "var(--input-bg)",
                    border: "1px solid var(--border-2)",
                    borderRadius: 8,
                    padding: "9px 11px",
                    fontSize: 11,
                    color: "var(--placeholder)",
                  }}
                >
                  message the room…
                </div>
              </div>
            </div>
          </div>
        </div>
        <p
          style={{ textAlign: "center", margin: "20px 0 0", fontSize: 12, color: "var(--muted-2)" }}
        >
          Every keystroke, tool call, and diff is broadcast to the room in real time — join late and
          you replay it gap-free.
        </p>
      </div>
    </section>
  );
};
