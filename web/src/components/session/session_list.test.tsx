import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { server } from "../../../test/msw_server";
import { SessionList } from "./session_list";

function renderList() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/sessions"]}>
        <Routes>
          <Route path="/sessions" element={<SessionList />} />
          <Route
            path="/sessions/:sessionId"
            element={<div data-testid="session-route">session</div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const ROW = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "1",
  title: "Ship it",
  mode: "review",
  status: "active",
  my_role: "owner",
  owned: true,
  last_activity_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  ...over,
});

describe("SessionList", () => {
  beforeEach(() => server.resetHandlers());
  afterEach(() => server.resetHandlers());

  it("groups sessions into Your sessions (owned) and Joined (not owned)", async () => {
    server.use(
      http.get("/api/sessions", () =>
        HttpResponse.json([
          ROW({ id: "1", title: "Mine", owned: true, my_role: "owner" }),
          ROW({ id: "2", title: "TheirsIJoined", owned: false, my_role: "reviewer" }),
        ]),
      ),
    );
    renderList();

    expect(await screen.findByText("Your sessions")).toBeInTheDocument();
    expect(screen.getByText("Joined")).toBeInTheDocument();
    expect(screen.getByText("Mine")).toBeInTheDocument();
    expect(screen.getByText("TheirsIJoined")).toBeInTheDocument();
  });

  it("badges rows only active or revoked", async () => {
    server.use(
      http.get("/api/sessions", () =>
        HttpResponse.json([
          ROW({ id: "1", title: "Active one", status: "active" }),
          ROW({ id: "2", title: "Ended one", status: "archived" }),
        ]),
      ),
    );
    renderList();

    const badges = await screen.findAllByTestId("status-badge");
    const labels = badges.map((b) => b.textContent);
    expect(labels).toEqual(["active", "revoked"]);
  });

  it("links a row into its session", async () => {
    server.use(
      http.get("/api/sessions", () => HttpResponse.json([ROW({ id: "42", title: "Go" })])),
    );
    renderList();

    fireEvent.click(await screen.findByText("Go"));
    expect(await screen.findByTestId("session-route")).toBeInTheDocument();
  });

  it("lets an owner end an active session, then shows it revoked with no control", async () => {
    let archived = false;
    server.use(
      http.get("/api/sessions", () =>
        HttpResponse.json([
          ROW({
            id: "7",
            title: "Owned",
            status: archived ? "archived" : "active",
            my_role: "owner",
            owned: true,
          }),
        ]),
      ),
      http.post("/api/sessions/7/archive", () => {
        archived = true;
        return HttpResponse.json({ id: "7", status: "archived" });
      }),
    );
    renderList();

    fireEvent.click(await screen.findByRole("button", { name: "end session" }));

    await waitFor(() => expect(screen.getByTestId("status-badge")).toHaveTextContent("revoked"));
    expect(screen.queryByRole("button", { name: "end session" })).not.toBeInTheDocument();
  });

  it("shows no end-session control on a joined (non-owner) session", async () => {
    server.use(
      http.get("/api/sessions", () =>
        HttpResponse.json([
          ROW({ id: "3", title: "TeammateSession", my_role: "reviewer", owned: false }),
        ]),
      ),
    );
    renderList();

    await screen.findByText("TeammateSession");
    expect(screen.queryByRole("button", { name: "end session" })).not.toBeInTheDocument();
  });
});
