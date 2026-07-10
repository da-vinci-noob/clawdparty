import { fireEvent, render, screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { server } from "../../test/msw_server";
import { DirectoryPicker } from "./directory_picker";

// A branching handler: the repo root lists proj (git) + docs; inside proj lists a
// single nested folder. Query param `path` selects the level (contract: "" = root).
function stubDirectories() {
  server.use(
    http.get("/api/directories", ({ request }) => {
      const path = new URL(request.url).searchParams.get("path") ?? "";
      if (path === "proj") {
        return HttpResponse.json({
          path: "proj",
          entries: [{ name: "nested", path: "proj/nested", is_git_repo: false }],
        });
      }
      return HttpResponse.json({
        path: "",
        entries: [
          { name: "proj", path: "proj", is_git_repo: true },
          { name: "docs", path: "docs", is_git_repo: false },
        ],
      });
    }),
  );
}

describe("DirectoryPicker", () => {
  it("renders the root listing with a git marker on git repos", async () => {
    stubDirectories();
    render(<DirectoryPicker value="" onChange={vi.fn()} />);

    const projRow = await screen.findByRole("button", { name: "Open proj" });
    const docsRow = screen.getByRole("button", { name: "Open docs" });
    expect(within(projRow).getByText("git")).toBeInTheDocument();
    expect(within(docsRow).queryByText("git")).not.toBeInTheDocument();
    expect(screen.getByTestId("directory-current")).toHaveTextContent("(repo root)");
  });

  it("navigates into a folder when its row is clicked", async () => {
    stubDirectories();
    render(<DirectoryPicker value="" onChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open proj" }));

    expect(await screen.findByRole("button", { name: "Open nested" })).toBeInTheDocument();
    expect(screen.getByTestId("directory-current")).toHaveTextContent("/proj");
  });

  it("goes back up to the parent when Up is clicked", async () => {
    stubDirectories();
    render(<DirectoryPicker value="" onChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open proj" }));
    await screen.findByRole("button", { name: "Open nested" });

    fireEvent.click(screen.getByRole("button", { name: "Up" }));

    expect(await screen.findByRole("button", { name: "Open proj" })).toBeInTheDocument();
    expect(screen.getByTestId("directory-current")).toHaveTextContent("(repo root)");
    expect(screen.getByRole("button", { name: "Up" })).toBeDisabled();
  });

  it("selects the current folder via 'Use this folder'", async () => {
    stubDirectories();
    const onChange = vi.fn();
    render(<DirectoryPicker value="" onChange={onChange} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open proj" }));
    await screen.findByRole("button", { name: "Open nested" });
    fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));

    expect(onChange).toHaveBeenCalledWith("proj");
  });

  it("falls back to a text input on a listing error", async () => {
    server.use(http.get("/api/directories", () => new HttpResponse(null, { status: 404 })));
    const onChange = vi.fn();
    render(<DirectoryPicker value="" onChange={onChange} />);

    const fallback = await screen.findByTestId("directory-fallback");
    expect(screen.queryByRole("button", { name: "Use this folder" })).not.toBeInTheDocument();

    fireEvent.change(fallback, { target: { value: "some/dir" } });
    expect(onChange).toHaveBeenCalledWith("some/dir");
  });
});
