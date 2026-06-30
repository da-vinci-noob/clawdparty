import { render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { makeFakeConsumer } from "../test/fake_consumer";
import { server } from "../test/msw_server";
import { AppProvider } from "./providers/app_provider";
import { AppRoutes } from "./routes";

describe("AppRoutes", () => {
  it("resolves the landing route to the join form", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("join-form")).toBeInTheDocument();
  });

  it("resolves the session route to the live activity feed", async () => {
    // The session route renders the live activity feed, which backfills over REST
    // and subscribes to cable. Stub the backfill (empty) and inject a fake consumer.
    server.use(http.get("/api/sessions/:id/events", () => HttpResponse.json([])));
    const { consumer } = makeFakeConsumer();

    render(
      <AppProvider consumerFactory={() => consumer}>
        <MemoryRouter initialEntries={["/sessions/abc"]}>
          <AppRoutes />
        </MemoryRouter>
      </AppProvider>,
    );

    expect(await screen.findByTestId("activity-feed")).toBeInTheDocument();
  });

  it("shows a not-found state (not the empty shell) for an unknown/not-joined session", async () => {
    // Backfill 404 = the session does not exist OR the requester has not joined.
    // The page must surface that, not render a blank working shell.
    server.use(http.get("/api/sessions/:id/events", () => new HttpResponse(null, { status: 404 })));
    const { consumer } = makeFakeConsumer();

    render(
      <AppProvider consumerFactory={() => consumer}>
        <MemoryRouter initialEntries={["/sessions/6"]}>
          <AppRoutes />
        </MemoryRouter>
      </AppProvider>,
    );

    expect(await screen.findByTestId("session-not-found")).toBeInTheDocument();
    expect(screen.queryByTestId("activity-feed")).not.toBeInTheDocument();
  });
});
