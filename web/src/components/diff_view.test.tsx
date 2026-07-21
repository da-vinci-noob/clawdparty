import type { EventEnvelope } from "@clawdparty/contracts";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { server } from "../../test/msw_server";
import { renderWithQuery } from "../../test/render_with_query";
import { useEventStore } from "../stores/event_store";
import { type Role, useParticipantStore } from "../stores/participant_store";
import { DiffView } from "./diff_view";
import { PromptComposer } from "./prompt_composer";

function setRole(role: Role) {
  useParticipantStore.getState().setCurrent({ id: "1", session_id: "s", role, name: "Me" });
}

const SAMPLE_PATCH = [
  "diff --git a/hello.txt b/hello.txt",
  "index e69de29..3b18e51 100644",
  "--- a/hello.txt",
  "+++ b/hello.txt",
  "@@ -1 +1,2 @@",
  "-hello",
  "+hello world",
  "+second line",
  "",
].join("\n");

function mockDiff(runId = "run_1") {
  server.use(
    http.get(`/api/runs/${runId}/diff`, () =>
      HttpResponse.json(
        {
          run_id: runId,
          base_sha: "abc123",
          files: [{ path: "hello.txt", insertions: 2, deletions: 1, binary: false }],
          patch: SAMPLE_PATCH,
        },
        { status: 200 },
      ),
    ),
  );
}

describe("DiffView (all roles review; owner-only controls)", () => {
  beforeEach(() => {
    // jsdom has no layout engine → Element.scrollIntoView is undefined; stub it so
    // the jump-to-file handler doesn't throw.
    Element.prototype.scrollIntoView = () => {};
    useParticipantStore.getState().clear();
    useEventStore.getState().reset();
  });
  afterEach(() => {
    useParticipantStore.getState().clear();
    useEventStore.getState().reset();
  });

  it("renders the file list and the parsed patch for a reviewer", async () => {
    mockDiff();
    setRole("reviewer");
    render(<DiffView runId="run_1" />);

    const file = await screen.findByTestId("diff-file");
    expect(file).toHaveTextContent("hello.txt");
    expect(file).toHaveTextContent("+2");
    expect(file).toHaveTextContent("1");
    expect(screen.getByTestId("diff-patch")).toBeInTheDocument();
    // A reviewer can now approve/reject (owner/editor/reviewer all can).
    expect(screen.getByTestId("approve-button")).toBeInTheDocument();
  });

  it("renders one collapsible section per file and toggles it on header click", async () => {
    const multiPatch = [
      "diff --git a/a.txt b/a.txt",
      "index e69de29..3b18e51 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-a",
      "+A",
      "diff --git a/b.txt b/b.txt",
      "index e69de29..3b18e51 100644",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1 +1 @@",
      "-b",
      "+B",
      "",
    ].join("\n");
    server.use(
      http.get("/api/runs/run_1/diff", () =>
        HttpResponse.json(
          {
            run_id: "run_1",
            base_sha: "abc123",
            files: [
              { path: "a.txt", insertions: 1, deletions: 1, binary: false },
              { path: "b.txt", insertions: 1, deletions: 1, binary: false },
            ],
            patch: multiPatch,
          },
          { status: 200 },
        ),
      ),
    );
    setRole("reviewer");
    render(<DiffView runId="run_1" />);

    // Two file-list rows and two patch sections, both expanded by default.
    await waitFor(() => expect(screen.getAllByTestId("diff-file")).toHaveLength(2));
    const headers = screen.getAllByTestId("diff-patch-header");
    expect(headers).toHaveLength(2);
    const [firstHeader] = headers as [HTMLElement, HTMLElement];
    expect(firstHeader).toHaveAttribute("aria-expanded", "true");

    // Collapsing the first section hides its hunks (aria-expanded flips to false).
    fireEvent.click(firstHeader);
    expect(screen.getAllByTestId("diff-patch-header")[0]).toHaveAttribute("aria-expanded", "false");
  });

  it("expands a collapsed section when its file-list row is clicked", async () => {
    mockDiff();
    setRole("reviewer");
    render(<DiffView runId="run_1" />);

    const header = await screen.findByTestId("diff-patch-header");
    fireEvent.click(header); // collapse
    expect(screen.getByTestId("diff-patch-header")).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByTestId("diff-file-jump")); // jump re-expands
    expect(screen.getByTestId("diff-patch-header")).toHaveAttribute("aria-expanded", "true");
  });

  it("shows an empty state when there are no changes", async () => {
    server.use(
      http.get("/api/runs/run_1/diff", () =>
        HttpResponse.json(
          { run_id: "run_1", base_sha: "abc123", files: [], patch: "" },
          { status: 200 },
        ),
      ),
    );
    setRole("reviewer");
    render(<DiffView runId="run_1" />);
    expect(await screen.findByTestId("diff-empty")).toBeInTheDocument();
  });

  it("surfaces a load error", async () => {
    server.use(
      http.get("/api/runs/run_1/diff", () =>
        HttpResponse.json({ errors: [{ message: "boom" }] }, { status: 500 }),
      ),
    );
    setRole("reviewer");
    render(<DiffView runId="run_1" />);
    expect(await screen.findByTestId("diff-error")).toHaveTextContent("boom");
  });

  it("shows Approve/Reject for an owner but not for a viewer", async () => {
    mockDiff();
    setRole("owner");
    const { unmount } = render(<DiffView runId="run_1" />);
    expect(await screen.findByTestId("approve-button")).toBeInTheDocument();
    expect(screen.getByTestId("reject-button")).toBeInTheDocument();
    unmount();

    mockDiff();
    setRole("viewer");
    render(<DiffView runId="run_1" />);
    await screen.findByTestId("diff-file");
    expect(screen.queryByTestId("approve-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("reject-button")).not.toBeInTheDocument();
  });

  it("POSTs approve when the owner clicks Approve", async () => {
    mockDiff();
    let approvedRunId: string | null = null;
    server.use(
      http.post("/api/runs/:id/approve", ({ params }) => {
        approvedRunId = params.id as string;
        return HttpResponse.json({ id: params.id, status: "approved" }, { status: 200 });
      }),
    );
    setRole("owner");
    render(<DiffView runId="run_1" />);

    fireEvent.click(await screen.findByTestId("approve-button"));
    await waitFor(() => expect(approvedRunId).toBe("run_1"));
  });

  it("POSTs reject when the owner clicks Reject", async () => {
    mockDiff();
    let rejectedRunId: string | null = null;
    server.use(
      http.post("/api/runs/:id/reject", ({ params }) => {
        rejectedRunId = params.id as string;
        return HttpResponse.json({ id: params.id, status: "rejected" }, { status: 200 });
      }),
    );
    setRole("owner");
    render(<DiffView runId="run_1" />);

    fireEvent.click(await screen.findByTestId("reject-button"));
    await waitFor(() => expect(rejectedRunId).toBe("run_1"));
  });

  it("surfaces a server refusal on approve without leaving the view", async () => {
    mockDiff();
    server.use(
      http.post("/api/runs/:id/approve", () =>
        HttpResponse.json({ errors: [{ message: "Run is not awaiting review" }] }, { status: 409 }),
      ),
    );
    setRole("owner");
    render(<DiffView runId="run_1" />);

    fireEvent.click(await screen.findByTestId("approve-button"));
    expect(await screen.findByTestId("review-error")).toHaveTextContent(
      "Run is not awaiting review",
    );
  });
});

describe("PromptComposer — revise while awaiting review", () => {
  function ev(over: Partial<EventEnvelope> & Pick<EventEnvelope, "type" | "id">): EventEnvelope {
    return {
      session_id: "s",
      ai_run_id: "run_1",
      seq: 1,
      actor: { kind: "system" },
      ts: "2026-07-10T00:00:00.000Z",
      payload: {},
      ...over,
    };
  }

  function seedAwaitingReview() {
    act(() =>
      useEventStore
        .getState()
        .applyMany([
          ev({ id: 1, seq: 1, type: "run_started", actor: { kind: "user", id: "1" } }),
          ev({ id: 2, seq: 2, type: "run_finished" }),
          ev({ id: 3, seq: 3, type: "changeset_ready" }),
        ]),
    );
  }

  beforeEach(() => {
    useParticipantStore.getState().clear();
    useEventStore.getState().reset();
  });
  afterEach(() => {
    useParticipantStore.getState().clear();
    useEventStore.getState().reset();
  });

  it('sends mode: "revise" for an editor while the current run awaits review', async () => {
    setRole("editor");
    let body: unknown = null;
    server.use(
      http.post("/api/sessions/:id/runs", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: "9", status: "queued" }, { status: 202 });
      }),
    );
    seedAwaitingReview();
    renderWithQuery(<PromptComposer sessionId="s" />);

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "tweak it" } });
    fireEvent.click(screen.getByText("Revise"));

    await waitFor(() =>
      // No model chosen → the key is omitted so the server applies its default.
      expect(body).toEqual({
        prompt: "tweak it",
        mode: "revise",
        permission_mode: "acceptEdits",
      }),
    );
  });

  it("sends a fresh run (no revise mode) when nothing awaits review", async () => {
    setRole("editor");
    let body: unknown = null;
    server.use(
      http.post("/api/sessions/:id/runs", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: "9", status: "queued" }, { status: 202 });
      }),
    );
    renderWithQuery(<PromptComposer sessionId="s" />);

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "do it" } });
    fireEvent.click(screen.getByText("Run"));

    await waitFor(() =>
      expect(body).toEqual({
        prompt: "do it",
        permission_mode: "acceptEdits",
      }),
    );
  });
});
