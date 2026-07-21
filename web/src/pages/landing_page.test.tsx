import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// Switch to the create tab (the mode toggle lives inside the hero form).
function switchToCreate() {
  fireEvent.click(within(screen.getByTestId("landing-mode-toggle")).getByText("create"));
}

describe("LandingPage — join flow", () => {
  beforeEach(() => useParticipantStore.getState().clear());
  afterEach(() => useParticipantStore.getState().clear());

  async function fillAndJoin() {
    fireEvent.change(screen.getByLabelText("Invite token"), { target: { value: "tok" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Alice" } });
    fireEvent.click(screen.getByRole("button", { name: "join session" }));
  }

  it("on success: posts { token, name }, stores the participant, routes into the session", async () => {
    let captured: Record<string, unknown> | null = null;
    server.use(
      http.post("/api/participants", async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          { id: "9", session_id: "42", role: "owner", name: "Alice" },
          { status: 201 },
        );
      }),
    );
    renderLanding();
    await fillAndJoin();

    await waitFor(() => expect(screen.getByTestId("session-route")).toBeInTheDocument());
    expect(captured).toEqual({ token: "tok", name: "Alice" });
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
  beforeEach(() => useParticipantStore.getState().clear());
  afterEach(() => useParticipantStore.getState().clear());

  it("defaults to review mode and omits repository_path when the dir is blank", async () => {
    let captured: Record<string, unknown> | null = null;
    server.use(
      http.post("/api/sessions", async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          { id: "1", session_id: "7", role: "owner", name: "Alice" },
          { status: 201 },
        );
      }),
    );
    renderLanding();
    switchToCreate();

    fireEvent.change(screen.getByLabelText("Session title"), { target: { value: "Ship it" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Alice" } });
    fireEvent.click(screen.getByRole("button", { name: "create session" }));

    await waitFor(() => expect(screen.getByTestId("session-route")).toBeInTheDocument());
    // Left untouched, the mode select posts "review" (git worktree + approve/reject)
    // and no working directory is sent.
    expect(captured).toEqual({ title: "Ship it", name: "Alice", mode: "review" });
    expect(useParticipantStore.getState().current).toMatchObject({
      session_id: "7",
      role: "owner",
    });
  });

  it("creates a chat-mode session with a working directory chosen via the folder picker", async () => {
    let captured: Record<string, unknown> | null = null;
    server.use(
      http.post("/api/sessions", async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          { id: "2", session_id: "8", role: "owner", name: "Alice" },
          { status: 201 },
        );
      }),
      // The folder picker browses repo-root-relative dirs (with git-repo badges),
      // so the working dir is CHOSEN, not typed — no literal "~/…" ever reaches the API.
      http.get("/api/directories", () =>
        HttpResponse.json({
          path: "",
          entries: [{ name: "my-repo", path: "my-repo", is_git_repo: true }],
        }),
      ),
    );
    renderLanding();
    switchToCreate();
    fireEvent.change(screen.getByLabelText("Session mode"), { target: { value: "chat" } });
    fireEvent.change(screen.getByLabelText("Session title"), { target: { value: "Chatty" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Alice" } });
    // Open the "my-repo" folder in the picker, then use it as the working directory.
    fireEvent.click(await screen.findByLabelText("Open my-repo"));
    fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
    fireEvent.click(screen.getByRole("button", { name: "create session" }));

    await waitFor(() => expect(screen.getByTestId("session-route")).toBeInTheDocument());
    expect(captured).toMatchObject({
      mode: "chat",
      repository_path: "my-repo",
      title: "Chatty",
    });
  });

  it("surfaces a create error and stays on the landing screen", async () => {
    server.use(
      http.post("/api/sessions", () =>
        HttpResponse.json({ errors: [{ message: "Title can't be blank" }] }, { status: 422 }),
      ),
    );
    renderLanding();
    switchToCreate();
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Alice" } });
    fireEvent.click(screen.getByRole("button", { name: "create session" }));

    expect(await screen.findByTestId("join-error")).toHaveTextContent("Title can't be blank");
    expect(screen.queryByTestId("session-route")).not.toBeInTheDocument();
  });
});

describe("LandingPage — theme toggle", () => {
  // The test runtime's built-in localStorage is a broken stub (its methods
  // throw — which is why the component guards every access in try/catch). Stub a
  // working in-memory Storage so persistence can be asserted.
  let store: Record<string, string> = {};
  const memoryStorage = {
    getItem: (k: string): string | null => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      store = {};
    },
    key: () => null,
    length: 0,
  } satisfies Storage;

  beforeEach(() => {
    store = {};
    vi.stubGlobal("localStorage", memoryStorage);
    useParticipantStore.getState().clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useParticipantStore.getState().clear();
  });

  it("toggles the cp-light class on the wrapper and persists to localStorage", () => {
    renderLanding();
    const wrapper = document.querySelector(".cp-landing");
    const toggle = screen.getByLabelText("Toggle light or dark mode");

    expect(wrapper).not.toHaveClass("cp-light");
    fireEvent.click(toggle);
    expect(wrapper).toHaveClass("cp-light");
    expect(localStorage.getItem("cp-theme")).toBe("light");

    fireEvent.click(toggle);
    expect(wrapper).not.toHaveClass("cp-light");
    expect(localStorage.getItem("cp-theme")).toBe("dark");
  });

  it("mounts in light mode when cp-theme=light is already persisted", () => {
    localStorage.setItem("cp-theme", "light");
    renderLanding();
    expect(document.querySelector(".cp-landing")).toHaveClass("cp-light");
  });
});
