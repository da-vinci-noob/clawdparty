import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "../../../test/msw_server";
import { renderWithQuery } from "../../../test/render_with_query";
import { SessionInfo } from "./session_info";

// A session's mode was invisible once you were inside it: the page never fetched the
// session, so nothing on screen distinguished a chat session (no worktree, no approve/
// reject, ever) from a review session that had produced no changes. Shown to EVERY role —
// the mode is not an owner setting, it is what the session is.
function stub(mode: "review" | "chat", repositoryPath: string | null) {
  server.use(
    http.get("/api/sessions/:id", () =>
      HttpResponse.json({ id: "s", mode, repository_path: repositoryPath }),
    ),
  );
}

describe("SessionInfo", () => {
  it("names chat mode and the directory the run edits", async () => {
    stub("chat", "/Users/dev/projects/app");
    renderWithQuery(<SessionInfo sessionId="s" />);

    const info = await screen.findByTestId("session-info");
    expect(info).toHaveTextContent("chat");
    expect(info).toHaveTextContent("/Users/dev/projects/app");
  });

  it("names review mode and the repository it worktrees from", async () => {
    stub("review", "/Users/dev/projects/app");
    renderWithQuery(<SessionInfo sessionId="s" />);

    expect(await screen.findByTestId("session-info")).toHaveTextContent("review");
  });

  it("says which one implies approve/reject, since that is the question being asked", async () => {
    stub("chat", "/repo");
    renderWithQuery(<SessionInfo sessionId="s" />);

    // "chat" alone does not tell a participant that approve/reject can never appear. That
    // inference is exactly what nobody made.
    expect(await screen.findByTestId("session-info")).toHaveTextContent(/no git review/i);
  });

  it("renders nothing when the session cannot be read", async () => {
    server.use(http.get("/api/sessions/:id", () => HttpResponse.json({}, { status: 404 })));
    renderWithQuery(<SessionInfo sessionId="s" />);

    expect(screen.queryByTestId("session-info")).not.toBeInTheDocument();
  });
});
