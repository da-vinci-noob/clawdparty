import type { EventEnvelope } from "@clawdparty/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunBanner } from "./run_banner";

function evt(type: EventEnvelope["type"], payload: unknown): EventEnvelope {
  return {
    id: 1,
    session_id: "s",
    ai_run_id: "r",
    seq: 2,
    type,
    actor: { kind: "user", id: "p1" },
    ts: "2026-07-17T00:00:00.000Z",
    payload,
  };
}

describe("RunBanner permission mode", () => {
  it("shows the mode chip for a run_started event", () => {
    render(
      <RunBanner
        event={evt("run_started", {
          model: "m",
          cwd: "/r",
          permission_mode: "plan",
          claude_session_id: "x",
        })}
        names={new Map([["p1", "Alice"]])}
      />,
    );
    expect(screen.getByTestId("run-mode")).toHaveTextContent("plan mode");
  });

  it("shows no mode chip for non-run_started events", () => {
    render(<RunBanner event={evt("run_finished", {})} names={new Map()} />);
    expect(screen.queryByTestId("run-mode")).not.toBeInTheDocument();
  });
});

describe("RunBanner capability echo", () => {
  it("shows the applied capabilities from a run_started payload", () => {
    render(
      <RunBanner
        event={evt("run_started", {
          model: "m",
          cwd: "/r",
          permission_mode: "acceptEdits",
          claude_session_id: "x",
          disallowed_tools: ["Bash"],
          connectors: ["github"],
          skills: ["pdf"],
        })}
        names={new Map([["p1", "Alice"]])}
      />,
    );
    const caps = screen.getByTestId("run-caps");
    expect(caps).toHaveTextContent("tools −Bash");
    expect(caps).toHaveTextContent("connectors: github");
    expect(caps).toHaveTextContent("skills: pdf");
  });

  it("shows no capability chip when the payload carries none", () => {
    render(
      <RunBanner
        event={evt("run_started", {
          model: "m",
          cwd: "/r",
          permission_mode: "acceptEdits",
          claude_session_id: "x",
        })}
        names={new Map()}
      />,
    );
    expect(screen.queryByTestId("run-caps")).not.toBeInTheDocument();
  });
});
