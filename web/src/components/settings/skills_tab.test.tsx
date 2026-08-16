import { fireEvent, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { server } from "../../../test/msw_server";
import { renderWithQuery } from "../../../test/render_with_query";
import { type Role, useParticipantStore } from "../../stores/participant_store";
import { SkillsTab } from "./skills_tab";

/**
 * The write half of the settings surface.
 *
 * A skill is INSTRUCTIONS CLAUDE WILL FOLLOW, so the tab is not a document editor: the destination
 * is an explicit choice (a HOST skill reaches every session on the machine, and the developer's own
 * terminal Claude Code), writes are owner-only, and "remove" says what it actually does — the
 * directory is renamed aside, not deleted.
 */

function setRole(role: Role) {
  useParticipantStore.getState().setCurrent({ id: "1", session_id: "s", role, name: "Me" });
}

function stubSkills(skills: Array<{ name: string; description: string }>) {
  server.use(
    http.get("/api/sessions/:id/skills", () =>
      HttpResponse.json({ skills, source: skills.length ? "host" : "unavailable" }),
    ),
  );
}

/** Captures what the browser actually sent, which is the part a server test cannot see. */
function captureWrites(): {
  adds: () => Record<string, unknown>[];
  deletes: () => string[];
} {
  const adds: Record<string, unknown>[] = [];
  const deletes: string[] = [];
  server.use(
    http.post("/api/sessions/:id/skills", async ({ request }) => {
      adds.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ ok: true }, { status: 201 });
    }),
    http.delete("/api/sessions/:id/skills/:name", ({ request, params }) => {
      const url = new URL(request.url);
      deletes.push(`${params.name}?${url.searchParams.get("scope")}`);
      return HttpResponse.json({ ok: true });
    }),
  );
  return { adds: () => adds, deletes: () => deletes };
}

beforeEach(() => {
  useParticipantStore.getState().clear();
  stubSkills([{ name: "deploy", description: "Ship to staging" }]);
});
afterEach(() => {
  server.resetHandlers();
  useParticipantStore.getState().clear();
});

describe("what every role sees", () => {
  it("lists the skills this session can see", async () => {
    setRole("viewer");
    renderWithQuery(<SkillsTab sessionId="s" />);

    expect(await screen.findByTestId("skill-row-deploy")).toHaveTextContent("Ship to staging");
  });

  it("shows an empty state rather than nothing", async () => {
    stubSkills([]);
    setRole("owner");
    renderWithQuery(<SkillsTab sessionId="s" />);

    await waitFor(() => expect(screen.getByTestId("skills-empty")).toBeInTheDocument());
  });
});

describe("a non-owner", () => {
  for (const role of ["editor", "reviewer", "viewer"] as const) {
    it(`hides every write control from a ${role} and says why`, async () => {
      setRole(role);
      renderWithQuery(<SkillsTab sessionId="s" />);
      await screen.findByTestId("skill-row-deploy");

      // Presentation only — the server's `manage_session` gate is the real one — but a hidden
      // control with no explanation reads as a missing feature.
      expect(screen.queryByTestId("skill-add-form")).not.toBeInTheDocument();
      expect(screen.queryByTestId("skill-remove-deploy-project")).not.toBeInTheDocument();
      expect(screen.getByTestId("skills-read-only")).toHaveTextContent(/owner/i);
    });
  }
});

describe("an owner adding a skill", () => {
  it("sends the name, description, body and scope", async () => {
    const captured = captureWrites();
    setRole("owner");
    renderWithQuery(<SkillsTab sessionId="s" />);

    fireEvent.change(await screen.findByTestId("skill-name"), {
      target: { value: "release-notes" },
    });
    fireEvent.change(screen.getByTestId("skill-description"), {
      target: { value: "Use when writing a release note" },
    });
    fireEvent.change(screen.getByTestId("skill-body"), { target: { value: "# Steps" } });
    fireEvent.click(screen.getByTestId("skill-add"));

    await waitFor(() => expect(captured.adds()).toHaveLength(1));
    expect(captured.adds()[0]).toEqual({
      scope: "project",
      name: "release-notes",
      description: "Use when writing a release note",
      body: "# Steps",
    });
  });

  it("defaults to the project scope and states the blast radius of each choice", async () => {
    setRole("owner");
    renderWithQuery(<SkillsTab sessionId="s" />);

    const scope = await screen.findByTestId("skill-scope");
    expect(scope).toHaveValue("project");
    expect(screen.getByTestId("skill-scope-note")).toHaveTextContent(/this repo only/i);

    fireEvent.change(scope, { target: { value: "host" } });
    // The words that stop someone adding a machine-wide instruction by accident.
    expect(screen.getByTestId("skill-scope-note")).toHaveTextContent(
      /EVERY session on this machine/,
    );
  });

  it("sends the host scope when chosen", async () => {
    const captured = captureWrites();
    setRole("owner");
    renderWithQuery(<SkillsTab sessionId="s" />);

    fireEvent.change(await screen.findByTestId("skill-scope"), { target: { value: "host" } });
    fireEvent.change(screen.getByTestId("skill-name"), { target: { value: "pdf" } });
    fireEvent.click(screen.getByTestId("skill-add"));

    await waitFor(() => expect(captured.adds()).toHaveLength(1));
    expect(captured.adds()[0]).toMatchObject({ scope: "host" });
  });

  it("cannot submit without a name", async () => {
    setRole("owner");
    renderWithQuery(<SkillsTab sessionId="s" />);

    expect(await screen.findByTestId("skill-add")).toBeDisabled();
  });

  it("surfaces the server's refusal, which is the actionable part", async () => {
    server.use(
      http.post("/api/sessions/:id/skills", () =>
        HttpResponse.json(
          {
            errors: [{ message: "A skill with that name already exists — replace it explicitly" }],
          },
          { status: 422 },
        ),
      ),
    );
    setRole("owner");
    renderWithQuery(<SkillsTab sessionId="s" />);

    fireEvent.change(await screen.findByTestId("skill-name"), { target: { value: "deploy" } });
    fireEvent.click(screen.getByTestId("skill-add"));

    expect(await screen.findByTestId("skills-error")).toHaveTextContent(/already exists/);
  });

  it("clears the form after a successful add", async () => {
    captureWrites();
    setRole("owner");
    renderWithQuery(<SkillsTab sessionId="s" />);

    fireEvent.change(await screen.findByTestId("skill-name"), { target: { value: "new-skill" } });
    fireEvent.click(screen.getByTestId("skill-add"));

    await waitFor(() => expect(screen.getByTestId("skill-name")).toHaveValue(""));
    expect(screen.getByTestId("skills-note")).toHaveTextContent(/Added new-skill/);
  });
});

describe("an owner removing a skill", () => {
  it("asks WHICH root, because the same name can exist in both", async () => {
    const captured = captureWrites();
    setRole("owner");
    renderWithQuery(<SkillsTab sessionId="s" />);

    fireEvent.click(await screen.findByTestId("skill-remove-deploy-host"));

    await waitFor(() => expect(captured.deletes()).toEqual(["deploy?host"]));
  });

  it("says the skill was MOVED ASIDE, not deleted", async () => {
    captureWrites();
    setRole("owner");
    renderWithQuery(<SkillsTab sessionId="s" />);

    fireEvent.click(await screen.findByTestId("skill-remove-deploy-project"));

    // The directory is renamed and survives on disk. Promising deletion would be a lie in the
    // other direction, and someone would go looking for a file they thought was gone.
    expect(await screen.findByTestId("skills-note")).toHaveTextContent(/Moved deploy aside/);
  });

  it("reports a removal the server refused", async () => {
    server.use(
      http.delete("/api/sessions/:id/skills/:name", () =>
        HttpResponse.json(
          { errors: [{ message: "That skill is not in this scope" }] },
          { status: 404 },
        ),
      ),
    );
    setRole("owner");
    renderWithQuery(<SkillsTab sessionId="s" />);

    fireEvent.click(await screen.findByTestId("skill-remove-deploy-project"));

    expect(await screen.findByTestId("skills-error")).toHaveTextContent(/not in this scope/);
  });
});
