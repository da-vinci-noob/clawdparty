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

describe("RunBanner renders no permission mode", () => {
  it("has no mode chip, because the concept is gone (CHANGELOG B2)", () => {
    render(
      <RunBanner
        event={evt("run_started", { model: "m", cwd: "/r" })}
        names={new Map([["p1", "Alice"]])}
      />,
    );
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
