import type { EventEnvelope } from "@clawdparty/contracts";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useEventStore } from "../stores/event_store";
import { type Role, useParticipantStore } from "../stores/participant_store";
import { InterruptButton } from "./interrupt_button";
import { PromptComposer } from "./prompt_composer";

function setRole(role: Role) {
  useParticipantStore.getState().setCurrent({ id: "1", session_id: "s", role, name: "Me" });
}

function startRunEvent(): EventEnvelope {
  return {
    id: 1,
    session_id: "s",
    ai_run_id: "run_1",
    seq: 1,
    type: "run_started",
    actor: { kind: "user", id: "1" },
    ts: "2026-06-28T20:11:00.000Z",
    payload: {},
  };
}

describe("run controls — role gating (presentation only; server enforces)", () => {
  beforeEach(() => {
    useParticipantStore.getState().clear();
    useEventStore.getState().reset();
  });
  afterEach(() => {
    useParticipantStore.getState().clear();
    useEventStore.getState().reset();
  });

  it("shows the composer for owner/editor, hides for reviewer/viewer", () => {
    for (const role of ["owner", "editor"] as Role[]) {
      setRole(role);
      const { unmount } = render(<PromptComposer sessionId="s" />);
      expect(screen.getByTestId("prompt-composer")).toBeInTheDocument();
      unmount();
    }
    for (const role of ["reviewer", "viewer"] as Role[]) {
      setRole(role);
      const { unmount } = render(<PromptComposer sessionId="s" />);
      expect(screen.queryByTestId("prompt-composer")).not.toBeInTheDocument();
      unmount();
    }
  });

  it("interrupt is hidden when no run is active, shown for owner during an active run", () => {
    setRole("owner");
    const { rerender } = render(<InterruptButton />);
    expect(screen.queryByTestId("interrupt-button")).not.toBeInTheDocument();

    act(() => useEventStore.getState().apply(startRunEvent()));
    rerender(<InterruptButton />);
    expect(screen.getByTestId("interrupt-button")).toBeInTheDocument();
  });

  it("interrupt stays hidden for a reviewer even during an active run", () => {
    setRole("reviewer");
    act(() => useEventStore.getState().apply(startRunEvent()));
    render(<InterruptButton />);
    expect(screen.queryByTestId("interrupt-button")).not.toBeInTheDocument();
  });
});
