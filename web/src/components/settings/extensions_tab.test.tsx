import { fireEvent, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { server } from "../../../test/msw_server";
import { renderWithQuery } from "../../../test/render_with_query";
import { type Role, useParticipantStore } from "../../stores/participant_store";
import { ExtensionsTab } from "./extensions_tab";

/**
 * the panel.
 *
 * The asymmetry is the point: active contributors and what they contribute are visible to EVERY
 * participant, because a `tool:before` gate decides what Claude may do and a viewer watching a
 * refusal should be able to see which rule refused. Toggling is owner-only, and the client only
 * hides the control — `SessionPolicy` is the gate.
 */

const GATE = "bundled:deny-destructive-bash";
const WRITE = "bundled:deny-out-of-tree-write";

function setRole(role: Role) {
  useParticipantStore.getState().setCurrent({ id: "1", session_id: "s", role, name: "Me" });
}

function stubPlugins(over: Array<Record<string, unknown>> = []) {
  server.use(
    http.get("/api/sessions/:id/plugins", () =>
      HttpResponse.json({
        plugins: over.length
          ? over
          : [
              {
                id: GATE,
                version: "1.0.0",
                origin: "bundled",
                contributes: ["tool:before"],
                summary: "Refuses obviously destructive shell commands.",
                enabled: true,
              },
              {
                id: WRITE,
                version: "1.0.0",
                origin: "bundled",
                contributes: ["tool:before"],
                summary: "Refuses a write outside the session worktree.",
                enabled: false,
              },
            ],
      }),
    ),
  );
}

/** What the browser actually PATCHed — the only proof a toggle was really sent. */
function capturePatch(): { last: () => { url: string; body: Record<string, unknown> } | null } {
  let captured: { url: string; body: Record<string, unknown> } | null = null;
  server.use(
    http.patch("/api/sessions/:id/plugins/*", async ({ request }) => {
      captured = { url: request.url, body: (await request.json()) as Record<string, unknown> };
      return HttpResponse.json({ id: GATE, enabled: false, active: [] });
    }),
  );
  return { last: () => captured };
}

beforeEach(() => {
  useParticipantStore.getState().clear();
  stubPlugins();
});
afterEach(() => {
  server.resetHandlers();
  useParticipantStore.getState().clear();
});

describe("what every role can see", () => {
  for (const role of ["owner", "editor", "reviewer", "viewer"] as const) {
    it(`shows a ${role} which rules are in force`, async () => {
      setRole(role);
      renderWithQuery(<ExtensionsTab sessionId="s" />);

      expect(await screen.findByTestId(`extension-${GATE}`)).toBeInTheDocument();
      // On vs off has to be legible without the toggle button, since three roles never see one.
      expect(screen.getByTestId(`extension-state-${GATE}`)).toHaveTextContent("●");
      expect(screen.getByTestId(`extension-state-${WRITE}`)).toHaveTextContent("○");
    });
  }

  it("names what each rule CONTRIBUTES, not just its id", async () => {
    setRole("viewer");
    renderWithQuery(<ExtensionsTab sessionId="s" />);

    // a reader needs the scope of the rule, and an id is not a scope.
    expect(await screen.findByTestId(`extension-contributes-${GATE}`)).toHaveTextContent(
      "tool:before",
    );
  });

  it("says WHEN a change applies, so an unchanged live run does not read as a broken toggle", async () => {
    setRole("owner");
    renderWithQuery(<ExtensionsTab sessionId="s" />);

    // Enablement resolves at run start. Someone expecting it to affect the run in front of
    // them would otherwise read the unchanged behaviour as the control not working.
    expect(await screen.findByTestId("extensions-timing")).toHaveTextContent(/next run/i);
    expect(screen.getByTestId("extensions-timing")).toHaveTextContent(/interrupt/i);
  });

  it("says outright that only bundled rules can run", async () => {
    setRole("owner");
    renderWithQuery(<ExtensionsTab sessionId="s" />);

    // Someone hunting for an install button deserves to learn it is a decision, not a gap.
    expect(await screen.findByTestId("extensions-bundled-only")).toHaveTextContent(
      /third-party extensions are not supported/i,
    );
  });
});

describe("who can change them", () => {
  it("lets an owner toggle, and sends the new state", async () => {
    const captured = capturePatch();
    setRole("owner");
    renderWithQuery(<ExtensionsTab sessionId="s" />);

    fireEvent.click(await screen.findByTestId(`extension-toggle-${GATE}`));

    await waitFor(() => expect(captured.last()).not.toBeNull());
    // It was ON, so the toggle must ask for OFF — sending the current state would be a no-op that
    // looked like it worked.
    expect(captured.last()?.body).toEqual({ enabled: false });
    expect(captured.last()?.url).toContain(encodeURIComponent(GATE));
  });

  it("asks to ENABLE one that is off", async () => {
    const captured = capturePatch();
    setRole("owner");
    renderWithQuery(<ExtensionsTab sessionId="s" />);

    fireEvent.click(await screen.findByTestId(`extension-toggle-${WRITE}`));

    await waitFor(() => expect(captured.last()).not.toBeNull());
    expect(captured.last()?.body).toEqual({ enabled: true });
  });

  for (const role of ["editor", "reviewer", "viewer"] as const) {
    it(`offers a ${role} no toggle, and says why`, async () => {
      setRole(role);
      renderWithQuery(<ExtensionsTab sessionId="s" />);

      await screen.findByTestId(`extension-${GATE}`);
      expect(screen.queryByTestId(`extension-toggle-${GATE}`)).not.toBeInTheDocument();
      // An absent control with no explanation reads as a broken page.
      expect(screen.getByTestId("extensions-read-only")).toHaveTextContent(/owner/i);
    });
  }
});

describe("when the server refuses", () => {
  it("surfaces the refusal verbatim", async () => {
    server.use(
      http.patch("/api/sessions/:id/plugins/*", () =>
        HttpResponse.json(
          { errors: [{ message: "unknown extension: bundled:nope" }] },
          { status: 422 },
        ),
      ),
    );
    setRole("owner");
    renderWithQuery(<ExtensionsTab sessionId="s" />);

    fireEvent.click(await screen.findByTestId(`extension-toggle-${GATE}`));

    expect(await screen.findByTestId("extensions-error")).toHaveTextContent(/unknown extension/);
  });

  it("still renders when the list cannot be read", async () => {
    server.use(
      http.get("/api/sessions/:id/plugins", () => new HttpResponse(null, { status: 502 })),
    );
    setRole("owner");
    renderWithQuery(<ExtensionsTab sessionId="s" />);

    // A settings tab that throws on a 502 is worse than one that shows an empty list.
    expect(await screen.findByTestId("extensions-tab")).toBeInTheDocument();
  });
});
