import { fireEvent, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../test/msw_server";
import { renderWithQuery } from "../../../test/render_with_query";
import { type CapabilitySelection, EMPTY_CAPABILITIES, SkillsPopover } from "./skills_popover";

function discovery(connectors: unknown[], skills: unknown[]): void {
  server.use(
    http.get("/api/sessions/:id/connectors", () =>
      HttpResponse.json({ connectors, source: connectors.length ? "project" : "unavailable" }),
    ),
    http.get("/api/sessions/:id/skills", () =>
      HttpResponse.json({ skills, source: skills.length ? "project" : "unavailable" }),
    ),
  );
}

function renderPopover(value: CapabilitySelection = EMPTY_CAPABILITIES): {
  onChange: ReturnType<typeof vi.fn>;
} {
  const onChange = vi.fn();
  renderWithQuery(
    <SkillsPopover sessionId="s" value={value} onChange={onChange} onClose={() => {}} />,
  );
  return { onChange };
}

describe("SkillsPopover", () => {
  afterEach(() => server.resetHandlers());

  it("renders the built-in tools on the default Tools tab (all ON)", () => {
    discovery([], []);
    renderPopover();
    expect(screen.getByTestId("cap-toggle-Bash")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("cap-toggle-Read")).toHaveAttribute("aria-pressed", "true");
  });

  it("renders discovered connectors (name + transport only)", async () => {
    discovery([{ name: "github", transport: "stdio" }], []);
    renderPopover();
    fireEvent.click(screen.getByRole("button", { name: "Connectors" }));
    const row = await screen.findByTestId("cap-toggle-github");
    // Default OFF, and only transport is shown — never command/url/env.
    expect(row).toHaveAttribute("aria-pressed", "false");
    expect(row).toHaveTextContent("stdio connector");
  });

  it("renders discovered skills (name + description)", async () => {
    discovery([], [{ name: "pdf", description: "Fill PDF forms" }]);
    renderPopover();
    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    const row = await screen.findByTestId("cap-toggle-pdf");
    expect(row).toHaveAttribute("aria-pressed", "false");
    expect(row).toHaveTextContent("Fill PDF forms");
  });

  it("shows an empty state when the host has no connectors", async () => {
    discovery([], []);
    renderPopover();
    fireEvent.click(screen.getByRole("button", { name: "Connectors" }));
    await waitFor(() =>
      expect(screen.getByTestId("cap-empty")).toHaveTextContent("No connectors configured"),
    );
  });

  it("toggling a tool OFF calls onChange with it added to disallowed_tools", () => {
    discovery([], []);
    const { onChange } = renderPopover();
    fireEvent.click(screen.getByTestId("cap-toggle-Bash"));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ disallowed_tools: ["Bash"] }));
  });

  it("toggling a connector ON calls onChange with its name added", async () => {
    discovery([{ name: "github", transport: "stdio" }], []);
    const { onChange } = renderPopover();
    fireEvent.click(screen.getByRole("button", { name: "Connectors" }));
    fireEvent.click(await screen.findByTestId("cap-toggle-github"));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ connectors: ["github"] }));
  });
});
