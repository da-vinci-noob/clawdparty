import type { EventEnvelope } from "@clawdparty/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useEventStore } from "../../stores/event_store";
import { ActivityFeed } from "../activity_feed";
import { ToolRefusedRow } from "./tool_refused_row";

function refused(over: Record<string, unknown> = {}): EventEnvelope {
  return {
    id: 5,
    session_id: "s",
    ai_run_id: "run1",
    seq: 4,
    type: "tool_refused",
    actor: { kind: "system" },
    ts: "2026-08-16T00:00:00.000Z",
    payload: {
      tool_use_id: "toolu_1",
      name: "bash",
      by: "bundled:deny-destructive-bash",
      reason: "refused: recursive delete of / or $HOME",
      ...over,
    },
  };
}

describe("ToolRefusedRow", () => {
  it("names what was refused, who refused it, and why", () => {
    render(<ToolRefusedRow event={refused()} />);

    // A refusal with no attribution reads as the session mysteriously stalling.
    expect(screen.getByTestId("feed-tool-refused")).toBeInTheDocument();
    expect(screen.getByTestId("feed-tool-refused")).toHaveTextContent("bash");
    expect(screen.getByTestId("feed-tool-refused")).toHaveTextContent(
      "bundled:deny-destructive-bash",
    );
    expect(screen.getByTestId("feed-tool-refused-reason")).toHaveTextContent(
      "recursive delete of / or $HOME",
    );
  });

  it("still renders when the payload carries no reason", () => {
    render(<ToolRefusedRow event={refused({ reason: undefined })} />);
    expect(screen.getByTestId("feed-tool-refused-reason")).toHaveTextContent("no reason given");
  });
});

describe("ActivityFeed renders a refusal distinctly from a failure", () => {
  it("gives tool_refused its own row rather than folding it into the tool chip", () => {
    useEventStore.getState().reset();
    useEventStore.getState().applyMany([refused()]);

    render(<ActivityFeed />);

    // A refusal is the room's policy acting, not a tool breaking. Rendering them
    // alike would make "we blocked this" look like "this crashed", and nobody
    // would learn that a rule exists.
    expect(screen.getByTestId("feed-tool-refused")).toBeInTheDocument();
    expect(screen.queryByTestId("feed-tool-chip")).not.toBeInTheDocument();
    useEventStore.getState().reset();
  });
});
