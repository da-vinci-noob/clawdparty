import { fireEvent, screen } from "@testing-library/react";
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
    // A "coming soon" tab reads as a broken feature rather than an unbuilt one. Provider
    // defaults appear when they land.
    setRole("owner");
    renderWithRouterAt(<AppRoutes />, "/sessions/s/settings");

    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["Configuration", "Auth test", "Skills setup"]);
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

  it("renders a readable state when the session cannot be read", async () => {
    server.use(http.get("/api/sessions/:id", () => new HttpResponse(null, { status: 404 })));
    setRole("owner");
    renderWithRouterAt(<AppRoutes />, "/sessions/s/settings");

    expect(await screen.findByTestId("configuration-unavailable")).toBeInTheDocument();
  });
});
