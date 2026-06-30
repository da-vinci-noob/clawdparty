import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { server } from "../../test/msw_server";
import { useParticipantStore } from "../stores/participant_store";
import { LandingPage } from "./landing_page";

function renderJoin() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
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

async function fillAndJoin() {
  fireEvent.change(screen.getByLabelText("Invite token"), { target: { value: "tok" } });
  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Alice" } });
  fireEvent.click(screen.getByText("Join"));
}

describe("LandingPage (join flow)", () => {
  beforeEach(() => useParticipantStore.getState().clear());
  afterEach(() => useParticipantStore.getState().clear());

  it("on success: stores the participant and routes into the session", async () => {
    server.use(
      http.post("/api/participants", () =>
        HttpResponse.json(
          { id: "9", session_id: "42", role: "owner", name: "Alice" },
          { status: 201 },
        ),
      ),
    );
    renderJoin();
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
    renderJoin();
    await fillAndJoin();

    expect(await screen.findByTestId("join-error")).toHaveTextContent("Not found");
    expect(screen.queryByTestId("session-route")).not.toBeInTheDocument();
    expect(useParticipantStore.getState().current).toBeNull();
  });
});
