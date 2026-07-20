import type { EventEnvelope } from "@clawdparty/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { server } from "../../test/msw_server";
import { renderWithQuery as renderComposer } from "../../test/render_with_query";
import { useEventStore } from "../stores/event_store";
import { type Role, useParticipantStore } from "../stores/participant_store";
import { PromptComposer } from "./prompt_composer";

function setRole(role: Role) {
  useParticipantStore.getState().setCurrent({ id: "1", session_id: "s", role, name: "Me" });
}

// Capture the body of the last POST to run start.
function captureRunStart(): { last: () => Record<string, unknown> | null } {
  let body: Record<string, unknown> | null = null;
  server.use(
    http.post("/api/sessions/:id/runs", async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ id: "run9", status: "queued" }, { status: 202 });
    }),
  );
  return { last: () => body };
}

function planRunFinished() {
  const started: EventEnvelope = {
    id: 1,
    session_id: "s",
    ai_run_id: "run1",
    seq: 2,
    type: "run_started",
    actor: { kind: "user", id: "1" },
    ts: "2026-07-17T00:00:00.000Z",
    payload: { model: "m", cwd: "/r", permission_mode: "plan", claude_session_id: "x" },
  };
  const finished: EventEnvelope = {
    ...started,
    id: 2,
    seq: 9,
    type: "run_finished",
    actor: { kind: "claude" },
    payload: {},
  };
  useEventStore.getState().applyMany([started, finished]);
}

describe("PromptComposer permission modes", () => {
  beforeEach(() => {
    useParticipantStore.getState().clear();
    useEventStore.getState().reset();
  });
  afterEach(() => {
    useParticipantStore.getState().clear();
    useEventStore.getState().reset();
  });

  it("is not rendered for a viewer (no run permission)", () => {
    setRole("viewer");
    renderComposer(<PromptComposer sessionId="s" />);
    expect(screen.queryByTestId("prompt-composer")).not.toBeInTheDocument();
  });

  it("sends the selected permission_mode on run start", async () => {
    const cap = captureRunStart();
    setRole("owner");
    renderComposer(<PromptComposer sessionId="s" />);

    fireEvent.change(screen.getByTestId("permission-mode"), { target: { value: "plan" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "do the thing" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(cap.last()).not.toBeNull());
    expect(cap.last()).toMatchObject({ prompt: "do the thing", permission_mode: "plan" });
  });

  it("hides the Bypass option from a non-owner (editor)", () => {
    setRole("editor");
    renderComposer(<PromptComposer sessionId="s" />);
    const options = Array.from(
      screen.getByTestId("permission-mode").querySelectorAll("option"),
    ).map((o) => o.textContent);
    expect(options).toEqual(["Plan", "Auto-accept"]);
  });

  it("offers Bypass to an owner", () => {
    setRole("owner");
    renderComposer(<PromptComposer sessionId="s" />);
    const options = Array.from(
      screen.getByTestId("permission-mode").querySelectorAll("option"),
    ).map((o) => o.textContent);
    expect(options).toContain("Bypass");
  });

  it("shows 'Execute plan' after a finished plan run and starts an auto-accept run", async () => {
    const cap = captureRunStart();
    setRole("owner");
    planRunFinished();
    renderComposer(<PromptComposer sessionId="s" />);

    fireEvent.click(await screen.findByTestId("execute-plan"));

    await waitFor(() => expect(cap.last()).not.toBeNull());
    expect(cap.last()).toMatchObject({ permission_mode: "acceptEdits" });
  });

  it("populates the model dropdown from GET /api/models and sends the chosen model", async () => {
    server.use(
      http.get("/api/models", () =>
        HttpResponse.json({
          source: "bedrock",
          models: [{ id: "us.anthropic.claude-opus-4-8", label: "Bedrock Opus 4.8" }],
        }),
      ),
    );
    const cap = captureRunStart();
    setRole("owner");
    renderComposer(<PromptComposer sessionId="s" />);

    // The discovered Bedrock model appears once the query resolves.
    await screen.findByRole("option", { name: "Bedrock Opus 4.8" });

    fireEvent.change(screen.getByTestId("model"), {
      target: { value: "us.anthropic.claude-opus-4-8" },
    });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(cap.last()).not.toBeNull());
    expect(cap.last()).toMatchObject({ model: "us.anthropic.claude-opus-4-8" });
  });

  it("omits model on run start when left on Default", async () => {
    const cap = captureRunStart();
    setRole("owner");
    renderComposer(<PromptComposer sessionId="s" />);

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(cap.last()).not.toBeNull());
    expect(cap.last()).not.toHaveProperty("model");
  });
});
