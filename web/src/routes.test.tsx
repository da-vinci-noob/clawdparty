import { render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { makeFakeConsumer } from "../test/fake_consumer";
import { server } from "../test/msw_server";
import { AppProvider } from "./providers/app_provider";
import { AppRoutes } from "./routes";

describe("AppRoutes", () => {
  it("resolves the landing route to its placeholder", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("landing-placeholder")).toBeInTheDocument();
  });

  it("resolves the session route to the live raw-event list", async () => {
    // The session route now renders the live transport, which backfills over REST
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

    expect(await screen.findByTestId("raw-event-list")).toBeInTheDocument();
  });
});
