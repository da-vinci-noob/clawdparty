import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { server } from "../../test/msw_server";
import { type Role, useParticipantStore } from "../stores/participant_store";
import { InvitePanel } from "./invite_panel";

function setRole(role: Role) {
  useParticipantStore.getState().setCurrent({ id: "1", session_id: "s", role, name: "Me" });
}

function inviteRow(id: string, role: Role, status: "active" | "revoked" | "expired") {
  return { id, role, created_at: "2026-07-17T00:00:00Z", expires_at: null, status };
}

describe("InvitePanel (owner-only; presentation gate)", () => {
  beforeEach(() => useParticipantStore.getState().clear());
  afterEach(() => useParticipantStore.getState().clear());

  it("renders for an owner and mints a copyable join link", async () => {
    server.use(
      http.get("/api/sessions/:id/invites", () => HttpResponse.json([])),
      http.post("/api/sessions/:id/invites", () =>
        HttpResponse.json(
          { id: "9", token: "raw-tok", role: "editor", session_id: "s" },
          { status: 201 },
        ),
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

  it("surfaces a server refusal on mint", async () => {
    server.use(
      http.get("/api/sessions/:id/invites", () => HttpResponse.json([])),
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

  it("lists the session's invites with their derived status", async () => {
    server.use(
      http.get("/api/sessions/:id/invites", () =>
        HttpResponse.json([
          inviteRow("1", "editor", "active"),
          inviteRow("2", "reviewer", "revoked"),
          inviteRow("3", "viewer", "expired"),
        ]),
      ),
    );
    setRole("owner");
    render(<InvitePanel sessionId="s" />);

    await screen.findByTestId("invite-list");
    expect(screen.getAllByTestId("invite-row")).toHaveLength(3);
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("revoked")).toBeInTheDocument();
    expect(screen.getByText("expired")).toBeInTheDocument();
    // Each row carries a unique #id so otherwise-identical invites are distinguishable.
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.getByText("#3")).toBeInTheDocument();
    // A revoked invite has no Revoke button; the active + expired ones do.
    expect(screen.getAllByRole("button", { name: /revoke .* invite/i })).toHaveLength(2);
  });

  it("revokes an invite and refetches the updated list", async () => {
    let invites = [inviteRow("1", "editor", "active")];
    let deleted: string | null = null;
    server.use(
      http.get("/api/sessions/:id/invites", () => HttpResponse.json(invites)),
      http.delete("/api/sessions/:id/invites/:inviteId", ({ params }) => {
        deleted = params.inviteId as string;
        invites = [inviteRow("1", "editor", "revoked")];
        return new HttpResponse(null, { status: 204 });
      }),
    );
    setRole("owner");
    render(<InvitePanel sessionId="s" />);

    fireEvent.click(await screen.findByRole("button", { name: /revoke editor invite/i }));

    await waitFor(() => expect(deleted).toBe("1"));
    // After the refetch the invite is revoked, so its Revoke button is gone.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /revoke editor invite/i }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText("revoked")).toBeInTheDocument();
  });

  it("surfaces a revoke failure", async () => {
    server.use(
      http.get("/api/sessions/:id/invites", () =>
        HttpResponse.json([inviteRow("1", "editor", "active")]),
      ),
      http.delete(
        "/api/sessions/:id/invites/:inviteId",
        () => new HttpResponse(null, { status: 500 }),
      ),
    );
    setRole("owner");
    render(<InvitePanel sessionId="s" />);

    fireEvent.click(await screen.findByRole("button", { name: /revoke editor invite/i }));

    await waitFor(() => expect(screen.getByText(/Revoke failed/)).toBeInTheDocument());
  });
});
