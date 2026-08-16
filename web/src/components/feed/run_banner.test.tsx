import { BUILTIN_TOOL_IDS, type EventEnvelope } from "@clawdparty/contracts";
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

describe("a run that withheld every tool", () => {
  const names = new Map([["p1", "Alice"]]);

  it("says so, so a late joiner is not left guessing", () => {
    // A run on a no-tools model can answer but not act. Without this the feed is
    // indistinguishable from a capable run that simply chose not to touch anything, and the
    // run_started event is the only place the resolved scope appears.
    render(
      <RunBanner
        event={evt("run_started", {
          model: "us.deepseek.r1-v1:0",
          cwd: "/r",
          disallowed_tools: [...BUILTIN_TOOL_IDS],
        })}
        names={names}
      />,
    );
    expect(screen.getByTestId("run-answer-only")).toHaveTextContent(/no tools/i);
  });

  it("stays quiet when only SOME tools were withheld", () => {
    // A partial disallow list is an ordinary per-run choice, not a capability limit.
    render(
      <RunBanner
        event={evt("run_started", { model: "m", cwd: "/r", disallowed_tools: ["Bash"] })}
        names={names}
      />,
    );
    expect(screen.queryByTestId("run-answer-only")).not.toBeInTheDocument();
  });

  it("stays quiet on an ordinary run and on other lifecycle events", () => {
    const { unmount } = render(
      <RunBanner event={evt("run_started", { model: "m", cwd: "/r" })} names={names} />,
    );
    expect(screen.queryByTestId("run-answer-only")).not.toBeInTheDocument();
    unmount();

    render(<RunBanner event={evt("run_finished", {})} names={names} />);
    expect(screen.queryByTestId("run-answer-only")).not.toBeInTheDocument();
  });
});
