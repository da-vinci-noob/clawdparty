import { fireEvent, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { server } from "../../../test/msw_server";
import { renderWithQuery } from "../../../test/render_with_query";
import { SkillsPopover } from "./skills_popover";

function discovery(connectors: unknown[], skills: unknown[]): void {
  server.use(
    http.get("/api/sessions/:id/connectors", () =>
      HttpResponse.json({ connectors, source: connectors.length ? "host" : "unavailable" }),
    ),
    http.get("/api/sessions/:id/skills", () =>
      HttpResponse.json({ skills, source: skills.length ? "host" : "unavailable" }),
    ),
  );
}

function renderPopover(): void {
  renderWithQuery(<SkillsPopover sessionId="s" onClose={() => {}} />);
}

describe("SkillsPopover (read-only capability display)", () => {
  afterEach(() => server.resetHandlers());

  it("lists the built-in tools on the default Tools tab (no toggles)", () => {
    discovery([], []);
    renderPopover();
    expect(screen.getByTestId("cap-item-Bash")).toBeInTheDocument();
    expect(screen.getByTestId("cap-item-Read")).toBeInTheDocument();
    // No per-item toggle switches anywhere.
    expect(screen.queryByTestId("cap-toggle-Bash")).not.toBeInTheDocument();
  });

  it("lists discovered connectors (name + transport only, read-only)", async () => {
    discovery([{ name: "github", transport: "stdio" }], []);
    renderPopover();
    fireEvent.click(screen.getByRole("button", { name: "Connectors" }));
    const row = await screen.findByTestId("cap-item-github");
    expect(row).toHaveTextContent("stdio connector");
    expect(screen.queryByTestId("cap-toggle-github")).not.toBeInTheDocument();
  });

  it("lists discovered skills (name + description, read-only)", async () => {
    discovery([], [{ name: "pdf", description: "Fill PDF forms" }]);
    renderPopover();
    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    const row = await screen.findByTestId("cap-item-pdf");
    expect(row).toHaveTextContent("Fill PDF forms");
    expect(row).not.toHaveAttribute("aria-pressed");
  });

  it("shows an empty state when the host has no connectors", async () => {
    discovery([], []);
    renderPopover();
    fireEvent.click(screen.getByRole("button", { name: "Connectors" }));
    await waitFor(() =>
      expect(screen.getByTestId("cap-empty")).toHaveTextContent("No connectors configured"),
    );
  });
});
