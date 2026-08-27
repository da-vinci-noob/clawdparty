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

function renderPopover(
  over: {
    enabledConnectors?: string[];
    onToggleConnector?: (name: string) => void;
  } = {},
): void {
  renderWithQuery(<SkillsPopover sessionId="s" onClose={() => {}} {...over} />);
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

  it("lists discovered connectors with name + transport, and a toggle", async () => {
    // Connectors are the ONE togglable capability: enabling one connects to that MCP
    // server and declares all of its tools, measured at ~37,500 tokens of schema for this host's
    // 8 servers, so it is chosen per run rather than inherited. Still name + transport only —
    // never the server's command/url/headers.
    discovery([{ name: "github", transport: "stdio" }], []);
    renderPopover();
    fireEvent.click(screen.getByRole("button", { name: "Connectors" }));
    const row = await screen.findByTestId("cap-item-github");
    expect(row).toHaveTextContent("stdio connector");
    expect(screen.getByTestId("cap-toggle-github")).toHaveAttribute("aria-pressed", "false");
  });

  it("shows an enabled connector as ON and reports a toggle", async () => {
    const toggled: string[] = [];
    discovery([{ name: "github", transport: "stdio" }], []);
    renderPopover({ enabledConnectors: ["github"], onToggleConnector: (n) => toggled.push(n) });
    fireEvent.click(screen.getByRole("button", { name: "Connectors" }));

    const toggle = await screen.findByTestId("cap-toggle-github");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    // The popover OWNS no state: the composer does, because it is what sends the run.
    expect(toggled).toEqual(["github"]);
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
