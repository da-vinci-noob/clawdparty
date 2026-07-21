import type { EventEnvelope } from "@clawdparty/contracts";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { server } from "../../test/msw_server";
import { useEventStore } from "../stores/event_store";
import { ChatPanel } from "./chat_panel";

function chatEvent(id: number, body: string, pid: string): EventEnvelope {
  return {
    id,
    session_id: "s",
    ai_run_id: null,
    seq: null,
    type: "chat_message",
    actor: { kind: "user", id: pid },
    ts: "2026-06-28T20:11:00.000Z",
    payload: { body },
  };
}

function joinEvent(id: number, pid: string, name: string): EventEnvelope {
  return {
    id,
    session_id: "s",
    ai_run_id: null,
    seq: null,
    type: "participant_joined",
    actor: { kind: "user", id: pid },
    ts: "2026-06-28T20:11:00.000Z",
    payload: { participant_id: pid, name, role: "editor" },
  };
}

describe("ChatPanel", () => {
  beforeEach(() => useEventStore.getState().reset());
  afterEach(() => useEventStore.getState().reset());

  it("renders chat_message events from the store, attributed by name", () => {
    render(<ChatPanel sessionId="s" />);
    act(() => {
      useEventStore.getState().apply(joinEvent(1, "p1", "Alice"));
      useEventStore.getState().apply(chatEvent(2, "hello team", "p1"));
    });
    const msg = screen.getByTestId("chat-message");
    expect(msg).toHaveTextContent("Alice");
    expect(msg).toHaveTextContent("hello team");
  });

  it("sends a chat message via the Rails endpoint", async () => {
    let posted: unknown = null;
    server.use(
      http.post("/api/sessions/:id/messages", async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({ id: "5", body: "ship it" }, { status: 201 });
      }),
    );
    render(<ChatPanel sessionId="s" />);
    fireEvent.change(screen.getByLabelText("Chat message"), { target: { value: "ship it" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(posted).toEqual({ body: "ship it" }));
  });

  it("shows a deduped roster of joined participants and the matching count", () => {
    render(<ChatPanel sessionId="s" />);
    act(() => {
      useEventStore.getState().apply(joinEvent(1, "p1", "Alice"));
      useEventStore.getState().apply(joinEvent(2, "p2", "Bob"));
      useEventStore.getState().apply(joinEvent(3, "p1", "Alice"));
    });
    const roster = screen.getByTestId("participant-roster");
    expect(roster).toHaveTextContent("Alice");
    expect(roster).toHaveTextContent("Bob");
    expect(screen.getAllByTestId("roster-participant")).toHaveLength(2);
    expect(screen.getByText("2 here")).toBeInTheDocument();
  });

  it("hides the roster before anyone has joined", () => {
    render(<ChatPanel sessionId="s" />);
    expect(screen.queryByTestId("participant-roster")).not.toBeInTheDocument();
    expect(screen.getByText("0 here")).toBeInTheDocument();
  });

  it("a late joiner sees prior chat (durable, in the store)", () => {
    // Prior chat already in the store (as if backfilled) before this panel mounts.
    act(() => useEventStore.getState().apply(chatEvent(2, "earlier message", "p1")));
    render(<ChatPanel sessionId="s" />);
    expect(screen.getByTestId("chat-message")).toHaveTextContent("earlier message");
  });
});
