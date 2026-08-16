import { fireEvent, render, screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { server } from "../../test/msw_server";
import { DirectoryPicker } from "./directory_picker";

// A branching handler mirroring the real three levels: the synthetic root list, a
// browse root, and a repo inside it. Paths are ABSOLUTE ( — with a configurable
// SET of roots a relative path has no unambiguous base), and each level supplies its
// own `parent`, which is what the client navigates by.
const ROOT = "/hosts/dev";

function stubDirectories() {
  server.use(
    http.get("/api/directories", ({ request }) => {
      const path = new URL(request.url).searchParams.get("path") ?? "";
      if (path === `${ROOT}/proj`) {
        return HttpResponse.json({
          path: `${ROOT}/proj`,
          parent: ROOT,
          is_git_repo: true,
          entries: [{ name: "nested", path: `${ROOT}/proj/nested`, is_git_repo: false }],
        });
      }
      if (path === ROOT) {
        return HttpResponse.json({
          path: ROOT,
          // A browse root's parent is the ROOT LIST, not "/hosts" — the property the
          // client must not try to derive.
          parent: "",
          is_git_repo: false,
          entries: [
            { name: "proj", path: `${ROOT}/proj`, is_git_repo: true },
            { name: "docs", path: `${ROOT}/docs`, is_git_repo: false },
          ],
        });
      }
      return HttpResponse.json({
        path: "",
        parent: null,
        is_git_repo: false,
        entries: [{ name: "dev", path: ROOT, is_git_repo: false }],
      });
    }),
  );
}

describe("DirectoryPicker", () => {
  it("lists the browse roots at the synthetic top level, with Up disabled", async () => {
    stubDirectories();
    render(<DirectoryPicker value="" onChange={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "Open dev" })).toBeInTheDocument();
    expect(screen.getByTestId("directory-current")).toHaveTextContent("(all repositories)");
    // parent: null means there is nothing above the root list.
    expect(screen.getByRole("button", { name: "Up" })).toBeDisabled();
  });

  it("disables Up until a listing has told it where the parent is", async () => {
    stubDirectories();
    render(<DirectoryPicker value={ROOT} onChange={vi.fn()} />);

    // Synchronously, before the fetch resolves: `current` is non-empty but no parent is
    // known yet. Gating on `current !== ""` instead would render an ENABLED Up button
    // whose click does nothing, because there is no parent to navigate to.
    expect(screen.getByRole("button", { name: "Up" })).toBeDisabled();

    await screen.findByRole("button", { name: "Open proj" });
    expect(screen.getByRole("button", { name: "Up" })).toBeEnabled();
  });

  it("renders a root's listing with a git marker on git repos", async () => {
    stubDirectories();
    render(<DirectoryPicker value={ROOT} onChange={vi.fn()} />);

    const projRow = await screen.findByRole("button", { name: "Open proj" });
    const docsRow = screen.getByRole("button", { name: "Open docs" });
    expect(within(projRow).getByText("git")).toBeInTheDocument();
    expect(within(docsRow).queryByText("git")).not.toBeInTheDocument();
    expect(screen.getByTestId("directory-current")).toHaveTextContent(ROOT);
  });

  it("navigates into a folder when its row is clicked", async () => {
    stubDirectories();
    render(<DirectoryPicker value={ROOT} onChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open proj" }));

    expect(await screen.findByRole("button", { name: "Open nested" })).toBeInTheDocument();
    expect(screen.getByTestId("directory-current")).toHaveTextContent(`${ROOT}/proj`);
  });

  it("goes up using the server's parent, not a client-side path slice", async () => {
    stubDirectories();
    render(<DirectoryPicker value={ROOT} onChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open proj" }));
    await screen.findByRole("button", { name: "Open nested" });

    fireEvent.click(screen.getByRole("button", { name: "Up" }));

    expect(await screen.findByRole("button", { name: "Open proj" })).toBeInTheDocument();
    expect(screen.getByTestId("directory-current")).toHaveTextContent(ROOT);
  });

  it("goes from a browse root UP TO THE ROOT LIST, not its filesystem parent", async () => {
    stubDirectories();
    render(<DirectoryPicker value={ROOT} onChange={vi.fn()} />);
    await screen.findByRole("button", { name: "Open proj" });

    fireEvent.click(screen.getByRole("button", { name: "Up" }));

    // The discriminating case. Slicing at the last "/" gives "/hosts", which is outside
    // every root and 404s. The server said parent: "" — the root list.
    expect(await screen.findByRole("button", { name: "Open dev" })).toBeInTheDocument();
    expect(screen.getByTestId("directory-current")).toHaveTextContent("(all repositories)");
  });

  it("selects the current folder via 'Use this folder'", async () => {
    stubDirectories();
    const onChange = vi.fn();
    render(<DirectoryPicker value={ROOT} onChange={onChange} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open proj" }));
    await screen.findByRole("button", { name: "Open nested" });
    fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));

    // An ABSOLUTE path: what session.repository_path already stores.
    expect(onChange).toHaveBeenCalledWith(`${ROOT}/proj`);
  });

  it("requireGit: disables 'Use this folder' at a non-git dir (with a hint)", async () => {
    stubDirectories();
    render(<DirectoryPicker value={ROOT} onChange={vi.fn()} requireGit />);

    await screen.findByRole("button", { name: "Open proj" });
    // A browse root is not itself a git repo → cannot use it for a review session.
    expect(screen.getByRole("button", { name: "Use this folder" })).toBeDisabled();
    expect(screen.getByTestId("require-git-hint")).toBeInTheDocument();
  });

  it("requireGit: enables 'Use this folder' inside a git repo and selects it", async () => {
    stubDirectories();
    const onChange = vi.fn();
    render(<DirectoryPicker value={ROOT} onChange={onChange} requireGit />);

    fireEvent.click(await screen.findByRole("button", { name: "Open proj" }));
    await screen.findByRole("button", { name: "Open nested" });
    const use = screen.getByRole("button", { name: "Use this folder" });
    expect(use).toBeEnabled();
    fireEvent.click(use);
    expect(onChange).toHaveBeenCalledWith(`${ROOT}/proj`);
  });

  it("falls back to a text input on a listing error", async () => {
    server.use(http.get("/api/directories", () => new HttpResponse(null, { status: 404 })));
    const onChange = vi.fn();
    render(<DirectoryPicker value="" onChange={onChange} />);

    const fallback = await screen.findByTestId("directory-fallback");
    expect(screen.queryByRole("button", { name: "Use this folder" })).not.toBeInTheDocument();

    fireEvent.change(fallback, { target: { value: "/hosts/dev/proj" } });
    expect(onChange).toHaveBeenCalledWith("/hosts/dev/proj");
  });
});
