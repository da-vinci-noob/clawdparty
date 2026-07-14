import type { EventEnvelope } from "@clawdparty/contracts";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { server } from "../../test/msw_server";
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

describe("prompt composer — server refusals are surfaced, not swallowed", () => {
  beforeEach(() => {
    useParticipantStore.getState().clear();
    useEventStore.getState().reset();
    setRole("owner");
  });
  afterEach(() => {
    useParticipantStore.getState().clear();
    useEventStore.getState().reset();
  });

  function typeAndRun(text = "do the thing") {
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: text } });
    fireEvent.click(screen.getByText("Run"));
  }

  it("shows an error when starting a run returns 409 (a run is already active)", async () => {
    server.use(
      http.post("/api/sessions/:id/runs", () =>
        HttpResponse.json(
          { errors: [{ message: "A run is already active for this session" }] },
          { status: 409 },
        ),
      ),
    );
    render(<PromptComposer sessionId="s" />);
    typeAndRun();

    expect(await screen.findByTestId("composer-error")).toHaveTextContent(
      "A run is already active for this session",
    );
  });

  it("keeps the prompt text when the start request fails (so it is not lost)", async () => {
    server.use(
      http.post("/api/sessions/:id/runs", () =>
        HttpResponse.json({ errors: [{ message: "boom" }] }, { status: 500 }),
      ),
    );
    render(<PromptComposer sessionId="s" />);
    typeAndRun("keep me");

    await screen.findByTestId("composer-error");
    expect(screen.getByLabelText("Prompt")).toHaveValue("keep me");
  });

  it("clears the prompt and shows no error on a successful start (202)", async () => {
    server.use(
      http.post("/api/sessions/:id/runs", () =>
        HttpResponse.json({ id: "7", status: "queued" }, { status: 202 }),
      ),
    );
    render(<PromptComposer sessionId="s" />);
    typeAndRun("go");

    await waitFor(() => expect(screen.getByLabelText("Prompt")).toHaveValue(""));
    expect(screen.queryByTestId("composer-error")).not.toBeInTheDocument();
  });
});
