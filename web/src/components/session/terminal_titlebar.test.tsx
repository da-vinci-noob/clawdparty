import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useEventStore } from "../../stores/event_store";
import { useParticipantStore } from "../../stores/participant_store";
import { TerminalTitlebar } from "./terminal_titlebar";

describe("TerminalTitlebar", () => {
  beforeEach(() => {
    useParticipantStore.getState().clear();
    useEventStore.getState().reset();
  });
  afterEach(() => {
    useParticipantStore.getState().clear();
    useEventStore.getState().reset();
  });

  it("shows <display name>@clawdparty and the selected directory's folder name", () => {
    useParticipantStore.getState().setCurrent({
      id: "1",
      session_id: "s",
      role: "owner",
      name: "Very",
      repository_path: "/repo/my-app",
    });
    render(<TerminalTitlebar />);
    expect(screen.getByTestId("titlebar-prompt")).toHaveTextContent("Very@clawdparty");
    expect(screen.getByTestId("titlebar-workspace")).toHaveTextContent("my-app");
  });

  it("falls back to clawd@clawdparty and ~/workspace before hydration", () => {
    render(<TerminalTitlebar />);
    expect(screen.getByTestId("titlebar-prompt")).toHaveTextContent("clawd@clawdparty");
    expect(screen.getByTestId("titlebar-workspace")).toHaveTextContent("~/workspace");
  });
});
