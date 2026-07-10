import { fireEvent, render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { server } from "../../test/msw_server";
import { type Role, useParticipantStore } from "../stores/participant_store";
import { ChangeDirectory } from "./change_directory";

function setRole(role: Role) {
  useParticipantStore.getState().setCurrent({ id: "1", session_id: "s", role, name: "Me" });
}

function stubRootListing() {
  server.use(
    http.get("/api/directories", () =>
      HttpResponse.json({
        path: "",
        entries: [{ name: "proj", path: "proj", is_git_repo: true }],
      }),
    ),
  );
}

describe("ChangeDirectory (owner-only; presentation gate)", () => {
  beforeEach(() => useParticipantStore.getState().clear());
  afterEach(() => useParticipantStore.getState().clear());

  it("renders for an owner and PATCHes the session on select", async () => {
    stubRootListing();
    let captured: Record<string, unknown> | null = null;
    server.use(
      http.patch("/api/sessions/:id", async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: "s", mode: "chat", repository_path: "proj" });
      }),
    );
    setRole("owner");
    render(<ChangeDirectory sessionId="s" />);

    fireEvent.click(screen.getByRole("button", { name: "Change directory" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open proj" }));
    fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));

    expect(await screen.findByTestId("change-directory-confirmation")).toBeInTheDocument();
    expect(captured).toEqual({ repository_path: "proj" });
  });

  it("does not render for non-owner roles", () => {
    for (const role of ["editor", "reviewer", "viewer"] as Role[]) {
      setRole(role);
      const { unmount } = render(<ChangeDirectory sessionId="s" />);
      expect(screen.queryByTestId("change-directory")).not.toBeInTheDocument();
      unmount();
    }
  });
});
