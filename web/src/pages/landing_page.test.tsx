import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { server } from "../../test/msw_server";
import { useParticipantStore } from "../stores/participant_store";
import { LandingPage } from "./landing_page";

function renderLanding(entry = "/") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route
          path="/sessions/:sessionId"
          element={<div data-testid="session-route">session</div>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

// Click the submit button INSIDE a form (the mode-toggle also has "Join"/"Create").
function submitForm(testid: string) {
  fireEvent.click(within(screen.getByTestId(testid)).getByRole("button"));
}

// The create form embeds the DirectoryPicker (multiple buttons), so the submit
// button is targeted by its accessible name instead of the single-button helper.
function submitCreate() {
  fireEvent.click(screen.getByRole("button", { name: "Create session" }));
}

describe("LandingPage — join flow", () => {
  beforeEach(() => useParticipantStore.getState().clear());
  afterEach(() => useParticipantStore.getState().clear());

  async function fillAndJoin() {
    fireEvent.change(screen.getByLabelText("Invite token"), { target: { value: "tok" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Alice" } });
    submitForm("join-form");
  }

  it("on success: stores the participant and routes into the session", async () => {
    server.use(
      http.post("/api/participants", () =>
        HttpResponse.json(
          { id: "9", session_id: "42", role: "owner", name: "Alice" },
          { status: 201 },
        ),
      ),
    );
    renderLanding();
    await fillAndJoin();

    await waitFor(() => expect(screen.getByTestId("session-route")).toBeInTheDocument());
    expect(useParticipantStore.getState().current).toMatchObject({
      id: "9",
      session_id: "42",
      role: "owner",
    });
  });

  it("on refusal: shows the error and stays on the join screen", async () => {
    server.use(
      http.post("/api/participants", () =>
        HttpResponse.json({ errors: [{ message: "Not found" }] }, { status: 404 }),
      ),
    );
    renderLanding();
    await fillAndJoin();

    expect(await screen.findByTestId("join-error")).toHaveTextContent("Not found");
    expect(screen.queryByTestId("session-route")).not.toBeInTheDocument();
    expect(useParticipantStore.getState().current).toBeNull();
  });

  it("prefills the token from ?token= (invite links deep-link into join)", () => {
    renderLanding("/?token=abc123");
    expect(screen.getByLabelText("Invite token")).toHaveValue("abc123");
  });
});

describe("LandingPage — create flow", () => {
  beforeEach(() => {
    useParticipantStore.getState().clear();
    // The create form now embeds the DirectoryPicker, which lists on mount.
    server.use(http.get("/api/directories", () => HttpResponse.json({ path: "", entries: [] })));
  });
  afterEach(() => useParticipantStore.getState().clear());

  it("switches to create mode and creates a session, routing in as owner", async () => {
    server.use(
      http.post("/api/sessions", () =>
        HttpResponse.json(
          { id: "1", session_id: "7", role: "owner", name: "Alice" },
          { status: 201 },
        ),
      ),
    );
    renderLanding();
    fireEvent.click(within(screen.getByTestId("landing-mode-toggle")).getByText("Create"));

    fireEvent.change(screen.getByLabelText("Session title"), { target: { value: "Ship it" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Alice" } });
    submitCreate();

    await waitFor(() => expect(screen.getByTestId("session-route")).toBeInTheDocument());
    expect(useParticipantStore.getState().current).toMatchObject({
      session_id: "7",
      role: "owner",
    });
  });

  it("creates a chat-mode session with a working directory picked from the folder tree", async () => {
    let captured: Record<string, unknown> | null = null;
    server.use(
      http.get("/api/directories", ({ request }) => {
        const path = new URL(request.url).searchParams.get("path") ?? "";
        if (path === "sub") {
          return HttpResponse.json({
            path: "sub",
            entries: [{ name: "dir", path: "sub/dir", is_git_repo: false }],
          });
        }
        return HttpResponse.json({
          path: "",
          entries: [{ name: "sub", path: "sub", is_git_repo: false }],
        });
      }),
      http.post("/api/sessions", async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          { id: "2", session_id: "8", role: "owner", name: "Alice" },
          { status: 201 },
        );
      }),
    );
    renderLanding();
    fireEvent.click(within(screen.getByTestId("landing-mode-toggle")).getByText("Create"));
    fireEvent.change(screen.getByLabelText("Session mode"), { target: { value: "chat" } });
    fireEvent.change(screen.getByLabelText("Session title"), { target: { value: "Chatty" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Alice" } });

    // Navigate sub → dir in the picker, then select it as the working directory.
    fireEvent.click(await screen.findByRole("button", { name: "Open sub" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open dir" }));
    fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));

    submitCreate();

    await waitFor(() => expect(screen.getByTestId("session-route")).toBeInTheDocument());
    expect(captured).toMatchObject({ mode: "chat", repository_path: "sub/dir", title: "Chatty" });
  });

  it("surfaces a create error and stays on the landing screen", async () => {
    server.use(
      http.post("/api/sessions", () =>
        HttpResponse.json({ errors: [{ message: "Title can't be blank" }] }, { status: 422 }),
      ),
    );
    renderLanding();
    fireEvent.click(within(screen.getByTestId("landing-mode-toggle")).getByText("Create"));
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Alice" } });
    submitCreate();

    expect(await screen.findByTestId("join-error")).toHaveTextContent("Title can't be blank");
    expect(screen.queryByTestId("session-route")).not.toBeInTheDocument();
  });
});
