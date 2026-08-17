import { fireEvent, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { server } from "../../test/msw_server";
import { renderWithRouterAt } from "../../test/render_with_query";
import { AppRoutes } from "../routes";
import { type Role, useParticipantStore } from "../stores/participant_store";

/**
 * The settings surface has its own route, its own tabs, and no placeholder tabs.
 *
 * Rendered through AppRoutes rather than the page component directly, because the route being
 * wired is half of what "there is a settings page" means: a component nothing navigates to is not
 * a page.
 */

function setRole(role: Role) {
  useParticipantStore.getState().setCurrent({ id: "1", session_id: "s", role, name: "Me" });
}

function stubSession(mode: "review" | "chat" = "chat") {
  server.use(
    http.get("/api/sessions/:id", () =>
      HttpResponse.json({ id: "s", mode, repository_path: "/Users/dev/app" }),
    ),
    http.get("/api/participants/current", () =>
      HttpResponse.json({ id: "1", session_id: "s", role: "owner", name: "Me" }),
    ),
    http.get("/api/models", () => HttpResponse.json({ providers: [] })),
  );
}

beforeEach(() => {
  useParticipantStore.getState().clear();
  stubSession();
});
afterEach(() => {
  server.resetHandlers();
  useParticipantStore.getState().clear();
});

describe("the settings route", () => {
  it("renders at /sessions/:id/settings", () => {
    setRole("owner");
    renderWithRouterAt(<AppRoutes />, "/sessions/s/settings");

    expect(screen.getByTestId("settings-page")).toBeInTheDocument();
  });

  it("opens on Configuration", async () => {
    setRole("owner");
    renderWithRouterAt(<AppRoutes />, "/sessions/s/settings");

    expect(screen.getByTestId("settings-tab-configuration")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(await screen.findByTestId("config-mode")).toBeInTheDocument();
  });

  it("switches to the auth test tab", async () => {
    setRole("owner");
    renderWithRouterAt(<AppRoutes />, "/sessions/s/settings");

    fireEvent.click(screen.getByTestId("settings-tab-auth"));
    expect(await screen.findByTestId("auth-test-run")).toBeInTheDocument();
  });

  it("offers no tab that is not built yet", () => {
    // A "coming soon" tab reads as a broken feature rather than an unbuilt one — every tab in the
    // list is one that works.
    setRole("owner");
    renderWithRouterAt(<AppRoutes />, "/sessions/s/settings");

    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["Configuration", "Provider", "Auth test", "Skills setup", "Extensions"]);
  });

  it("is reachable by a viewer, not just an owner", async () => {
    // The auth test is how a participant learns WHY a provider is missing instead of asking
    // someone else to look. Write controls stay owner-only, tab by tab.
    setRole("viewer");
    renderWithRouterAt(<AppRoutes />, "/sessions/s/settings");

    expect(screen.getByTestId("settings-page")).toBeInTheDocument();
    expect(await screen.findByTestId("config-read-only")).toBeInTheDocument();
  });

  it("links back to the session", () => {
    setRole("owner");
    renderWithRouterAt(<AppRoutes />, "/sessions/s/settings");

    expect(screen.getByTestId("settings-back")).toHaveAttribute("href", "/sessions/s");
  });
});

describe("the Configuration tab", () => {
  it("says which scope each row belongs to", async () => {
    setRole("owner");
    renderWithRouterAt(<AppRoutes />, "/sessions/s/settings");

    // A page that mixes session-scoped and host-wide values without saying which is which
    // produces "I changed it and the other session didn't".
    const mode = await screen.findByTestId("config-mode");
    expect(mode).toHaveTextContent(/this session/);
    expect(mode).toHaveTextContent(/fixed at creation/);
  });

  it("explains what the mode implies, not just its name", async () => {
    setRole("owner");
    renderWithRouterAt(<AppRoutes />, "/sessions/s/settings");

    expect(await screen.findByTestId("config-mode")).toHaveTextContent(/no git review/);
  });

  it("lets an owner rename the session", async () => {
    let patched: Record<string, unknown> | null = null;
    server.use(
      http.patch("/api/sessions/:id", async ({ request }) => {
        patched = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: "s", mode: "chat", repository_path: "/Users/dev/app" });
      }),
    );
    setRole("owner");
    renderWithRouterAt(<AppRoutes />, "/sessions/s/settings");

    fireEvent.change(await screen.findByTestId("config-title"), { target: { value: "New name" } });
    fireEvent.click(screen.getByTestId("config-title-save"));

    await waitFor(() => expect(patched).not.toBeNull());
    // Title ONLY: sending repository_path would make the endpoint recompute the working directory,
    // which defaults to the repo root — a rename would silently move the session.
    expect(patched).toEqual({ title: "New name" });
  });

  it("makes an owner confirm an archive, and says what it costs everyone", async () => {
    setRole("owner");
    renderWithRouterAt(<AppRoutes />, "/sessions/s/settings");

    fireEvent.click(await screen.findByTestId("config-archive"));

    // Terminal, and shared: the sentence says what happens to the room, not just to the clicker.
    expect(screen.getByTestId("config-archive-warning")).toHaveTextContent(/no new run/i);
    expect(screen.getByTestId("config-archive-warning")).toHaveTextContent(/for anyone/i);
    fireEvent.click(screen.getByTestId("config-archive-cancel"));
    expect(screen.queryByTestId("config-archive-confirm")).not.toBeInTheDocument();
  });

  it("hides rename and archive from a non-owner", async () => {
    setRole("editor");
    renderWithRouterAt(<AppRoutes />, "/sessions/s/settings");
    await screen.findByTestId("config-mode");

    expect(screen.queryByTestId("config-title-form")).not.toBeInTheDocument();
    expect(screen.queryByTestId("config-archive")).not.toBeInTheDocument();
  });

  it("renders a readable state when the session cannot be read", async () => {
    server.use(http.get("/api/sessions/:id", () => new HttpResponse(null, { status: 404 })));
    setRole("owner");
    renderWithRouterAt(<AppRoutes />, "/sessions/s/settings");

    expect(await screen.findByTestId("configuration-unavailable")).toBeInTheDocument();
  });
});
