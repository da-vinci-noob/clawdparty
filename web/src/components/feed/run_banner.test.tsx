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

describe("a skill change", () => {
  const names = new Map([["p1", "Alice"]]);

  it("names the person, the skill, and the scope", () => {
    render(
      <RunBanner
        event={evt("skill_changed", { action: "added", name: "release-notes", scope: "project" })}
        names={names}
      />,
    );

    // WHO is the point of the audit trail; scope is the point of the sentence, because a host skill
    // reaches every session on the machine.
    const banner = screen.getByTestId("feed-run-banner");
    expect(banner).toHaveTextContent("Alice");
    expect(banner).toHaveTextContent(/added the this repo skill release-notes/);
  });

  it("says host-wide when it was host-wide", () => {
    render(
      <RunBanner
        event={evt("skill_changed", { action: "added", name: "pdf", scope: "host" })}
        names={names}
      />,
    );
    expect(screen.getByTestId("feed-run-banner")).toHaveTextContent(/host-wide skill pdf/);
  });

  it("says MOVED ASIDE for a removal, because nothing was deleted", () => {
    render(
      <RunBanner
        event={evt("skill_changed", {
          action: "removed",
          name: "deploy",
          scope: "project",
          moved_to: "deploy.removed",
        })}
        names={names}
      />,
    );
    expect(screen.getByTestId("feed-run-banner")).toHaveTextContent(
      /moved the this repo skill deploy aside/,
    );
  });
});

describe("a connector the run could not load", () => {
  const names = new Map([["p1", "Alice"]]);

  it("names it and why, rather than leaving the participant with silent absence", () => {
    // Measured live: `linear` on this host fails with an auth error, the run completes normally,
    // and without this the person who enabled it sees no tools from it and no explanation.
    render(
      <RunBanner
        event={evt("run_started", {
          model: "m",
          cwd: "/r",
          connectors_failed: [{ name: "linear", kind: "failed" }],
        })}
        names={names}
      />,
    );
    expect(screen.getByTestId("run-connector-failed-linear")).toHaveTextContent(
      /failed to connect/i,
    );
  });

  it("distinguishes a name the host never configured from one that timed out", () => {
    render(
      <RunBanner
        event={evt("run_started", {
          model: "m",
          cwd: "/r",
          connectors_failed: [
            { name: "ghost", kind: "not_configured" },
            { name: "slow", kind: "timeout" },
          ],
        })}
        names={names}
      />,
    );
    // Three kinds because three remedies: configure it, retry, or fix the server.
    expect(screen.getByTestId("run-connector-failed-ghost")).toHaveTextContent(/not configured/i);
    expect(screen.getByTestId("run-connector-failed-slow")).toHaveTextContent(/did not respond/i);
  });

  it("says nothing when every connector loaded", () => {
    render(
      <RunBanner
        event={evt("run_started", { model: "m", cwd: "/r", connectors: ["slack-local"] })}
        names={names}
      />,
    );
    expect(screen.queryByTestId("run-connector-failed-slack-local")).not.toBeInTheDocument();
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
