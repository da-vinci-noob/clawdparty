import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { server } from "../../test/msw_server";
import { type Role, useParticipantStore } from "../stores/participant_store";
import { InvitePanel } from "./invite_panel";

function setRole(role: Role) {
  useParticipantStore.getState().setCurrent({ id: "1", session_id: "s", role, name: "Me" });
}

describe("InvitePanel (owner-only; presentation gate)", () => {
  beforeEach(() => useParticipantStore.getState().clear());
  afterEach(() => useParticipantStore.getState().clear());

  it("renders for an owner and mints a copyable join link", async () => {
    server.use(
      http.post("/api/sessions/:id/invites", () =>
        HttpResponse.json({ token: "raw-tok", role: "editor", session_id: "s" }, { status: 201 }),
      ),
    );
    setRole("owner");
    render(<InvitePanel sessionId="s" />);

    fireEvent.click(screen.getByText("Create link"));

    const link = (await screen.findByTestId("invite-link")) as HTMLInputElement;
    expect(link.value).toContain("/?token=raw-tok");
  });

  it("does not render for non-owner roles", () => {
    for (const role of ["editor", "reviewer", "viewer"] as Role[]) {
      setRole(role);
      const { unmount } = render(<InvitePanel sessionId="s" />);
      expect(screen.queryByTestId("invite-panel")).not.toBeInTheDocument();
      unmount();
    }
  });

  it("surfaces a server refusal", async () => {
    server.use(
      http.post("/api/sessions/:id/invites", () =>
        HttpResponse.json({ errors: [{ message: "Forbidden" }] }, { status: 403 }),
      ),
    );
    setRole("owner");
    render(<InvitePanel sessionId="s" />);
    fireEvent.click(screen.getByText("Create link"));

    await waitFor(() => expect(screen.getByText("Forbidden")).toBeInTheDocument());
    expect(screen.queryByTestId("invite-link")).not.toBeInTheDocument();
  });
});
