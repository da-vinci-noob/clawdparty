import type { EventEnvelope } from "@clawdparty/contracts";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { server } from "../../test/msw_server";
import { renderWithQuery } from "../../test/render_with_query";
import { useEventStore } from "../stores/event_store";
import { ReviewPanel } from "./review_panel";

/**
 * A chat session must not be indistinguishable from a review session with no changes.
 *
 * The review affordance was gated purely on a `changeset_ready` event having arrived. That
 * produces the right OUTCOME for chat — a chat run never enters `awaiting_review`, so no
 * changeset exists — but for the wrong reason, and the two states then render identically:
 * nothing. A participant who had just watched Claude edit files saw no diff, no approve
 * button, and no explanation, which is what got reported as a bug.
 *
 * `session-run-modes` requires the web to "omit the diff/approval affordances for a chat
 * session". Omitting them because no changeset happens to exist satisfies the letter while
 * leaving the participant unable to tell chat mode from a review session that produced
 * nothing. The mode is the governing input, so the mode is what this gates on.
 */

const REPO = "/Users/dev/projects/app";

function stubSession(mode: "review" | "chat", repositoryPath: string | null = REPO) {
  server.use(
    http.get("/api/sessions/:id", () =>
      HttpResponse.json({ id: "s", mode, repository_path: repositoryPath }),
    ),
  );
}

let nextId = 1;

function durable(type: string, payload: Record<string, unknown>, aiRunId = "7"): EventEnvelope {
  const id = nextId++;
  return {
    id,
    session_id: "s",
    ai_run_id: aiRunId,
    seq: id,
    type: type as EventEnvelope["type"],
    actor: { kind: "claude" },
    ts: "2026-08-16T00:00:00.000Z",
    payload,
  };
}

function fileChanged(path: string, aiRunId = "7"): EventEnvelope {
  return durable("file_changed", { path, change: "modified", tool_use_id: "t1" }, aiRunId);
}

beforeEach(() => {
  nextId = 1;
  useEventStore.getState().reset();
});
afterEach(() => useEventStore.getState().reset());

describe("a chat session", () => {
  it("explains where the edits went instead of showing nothing", async () => {
    stubSession("chat");
    useEventStore
      .getState()
      .applyMany([durable("run_started", {}), fileChanged(`${REPO}/README.md`)]);

    renderWithQuery(<ReviewPanel sessionId="s" />);

    const notice = await screen.findByTestId("chat-mode-notice");
    expect(notice).toBeInTheDocument();
    // The working directory is the answer to "where are my changes?" — a chat run edits it
    // directly, with no worktree in between.
    expect(notice).toHaveTextContent(REPO);
  });

  it("lists the files that changed, since there is no diff to open", async () => {
    stubSession("chat");
    useEventStore
      .getState()
      .applyMany([
        durable("run_started", {}),
        fileChanged(`${REPO}/README.md`),
        fileChanged(`${REPO}/src/app.ts`),
      ]);

    renderWithQuery(<ReviewPanel sessionId="s" />);

    await screen.findByTestId("chat-mode-notice");
    const paths = screen.getAllByTestId("chat-changed-path").map((el) => el.textContent);
    // Paths are shown relative to the working directory: the absolute host path is long
    // enough to bury the part that identifies the file.
    expect(paths).toEqual(["README.md", "src/app.ts"]);
  });

  it("shows each path once even when a file is edited repeatedly", async () => {
    stubSession("chat");
    useEventStore
      .getState()
      .applyMany([
        durable("run_started", {}),
        fileChanged(`${REPO}/README.md`),
        fileChanged(`${REPO}/README.md`),
      ]);

    renderWithQuery(<ReviewPanel sessionId="s" />);

    await screen.findByTestId("chat-mode-notice");
    expect(screen.getAllByTestId("chat-changed-path")).toHaveLength(1);
  });

  it("never offers a diff, even if a changeset_ready somehow arrives", async () => {
    stubSession("chat");
    useEventStore
      .getState()
      .applyMany([
        durable("run_started", {}),
        fileChanged(`${REPO}/README.md`),
        durable("changeset_ready", { files: 1 }),
      ]);

    renderWithQuery(<ReviewPanel sessionId="s" />);

    // Belt and braces against the inverse of the original bug: a chat session has no
    // worktree, so a diff request would 404 or describe someone else's tree. Gating on the
    // changeset event alone would open one here.
    await screen.findByTestId("chat-mode-notice");
    expect(screen.queryByTestId("diff-view")).not.toBeInTheDocument();
  });

  it("stays quiet until a run has actually touched a file", async () => {
    stubSession("chat");
    useEventStore
      .getState()
      .applyMany([durable("run_started", {}), durable("ai_text", { text: "hi" })]);

    renderWithQuery(<ReviewPanel sessionId="s" />);

    // The notice answers a question the participant only has once edits exist. Showing it
    // for a pure question-and-answer session would be noise.
    await waitFor(() => expect(screen.queryByTestId("chat-mode-notice")).not.toBeInTheDocument());
  });

  it("falls back to the bare path when the working directory is unknown", async () => {
    stubSession("chat", null);
    useEventStore
      .getState()
      .applyMany([durable("run_started", {}), fileChanged("/elsewhere/x.ts")]);

    renderWithQuery(<ReviewPanel sessionId="s" />);

    expect(await screen.findByTestId("chat-changed-path")).toHaveTextContent("/elsewhere/x.ts");
  });
});

describe("a review session", () => {
  it("shows the diff once a changeset is ready", async () => {
    stubSession("review");
    server.use(
      http.get("/api/runs/:id/diff", () =>
        HttpResponse.json({ base_sha: "abc", files: [], patch: "" }),
      ),
    );
    useEventStore
      .getState()
      .applyMany([durable("run_started", {}), durable("changeset_ready", { files: 1 })]);

    renderWithQuery(<ReviewPanel sessionId="s" />);

    expect(await screen.findByTestId("diff-view")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-mode-notice")).not.toBeInTheDocument();
  });

  it("shows nothing before a changeset is ready", async () => {
    stubSession("review");
    useEventStore.getState().applyMany([durable("run_started", {}), fileChanged(`${REPO}/a.ts`)]);

    renderWithQuery(<ReviewPanel sessionId="s" />);

    // Mid-run file_changed events are not a changeset: the run has to finish dirty for
    // there to be anything to approve.
    await waitFor(() => expect(screen.queryByTestId("diff-view")).not.toBeInTheDocument());
    expect(screen.queryByTestId("chat-mode-notice")).not.toBeInTheDocument();
  });
});

describe("before the session is known", () => {
  it("renders nothing rather than guessing a mode", async () => {
    server.use(http.get("/api/sessions/:id", () => HttpResponse.json({}, { status: 404 })));
    useEventStore
      .getState()
      .applyMany([durable("run_started", {}), durable("changeset_ready", { files: 1 })]);

    renderWithQuery(<ReviewPanel sessionId="s" />);

    // Defaulting to review would flash a diff panel at a chat session, and defaulting to
    // chat would hide a real approve button. Neither is recoverable by the participant.
    await waitFor(() => expect(screen.queryByTestId("diff-view")).not.toBeInTheDocument());
    expect(screen.queryByTestId("chat-mode-notice")).not.toBeInTheDocument();
  });
});
