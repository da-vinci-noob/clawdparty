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

describe("RunBanner has no capability echo", () => {
  it("never renders connectors/skills on run_started (always-on, not echoed)", () => {
    render(
      <RunBanner
        event={evt("run_started", {
          model: "m",
          cwd: "/r",
          permission_mode: "acceptEdits",
          claude_session_id: "x",
          connectors: ["github"],
          skills: ["pdf"],
        })}
        names={new Map([["p1", "Alice"]])}
      />,
    );
    expect(screen.queryByTestId("run-caps")).not.toBeInTheDocument();
    expect(screen.queryByText(/connectors:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/skills:/)).not.toBeInTheDocument();
  });
});
