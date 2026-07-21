import { fireEvent, render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { type FC, useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { server } from "../../../test/msw_server";
import { type HeroForm, LandingHero } from "./landing_hero";

function createForm(over: Partial<HeroForm> = {}): HeroForm {
  return {
    tab: "create",
    token: "",
    name: "",
    title: "",
    mode: "review",
    directory: "",
    busy: false,
    error: null,
    setTab: () => {},
    setToken: () => {},
    setName: () => {},
    setTitle: () => {},
    setMode: () => {},
    setDirectory: () => {},
    onSubmit: () => {},
    ...over,
  };
}

describe("LandingHero create form", () => {
  beforeEach(() => {
    server.use(
      http.get("/api/directories", () =>
        HttpResponse.json({
          path: "",
          entries: [{ name: "my-repo", path: "my-repo", is_git_repo: true }],
        }),
      ),
    );
  });

  it("offers the directory PICKER (not a free-text path field) in create mode", async () => {
    render(<LandingHero form={createForm()} />);
    // The folder browser (git-badge-guided), not a plain "working directory" text input.
    expect(await screen.findByTestId("directory-picker")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/working directory/i)).not.toBeInTheDocument();
  });

  it("disables 'create session' until a working directory is selected", async () => {
    // Path-aware picker: the root is not a git repo; opening my-repo is, so
    // "Use this folder" enables and sets form.directory.
    server.use(
      http.get("/api/directories", ({ request }) => {
        const path = new URL(request.url).searchParams.get("path") ?? "";
        if (path === "my-repo") {
          return HttpResponse.json({
            path: "my-repo",
            is_git_repo: true,
            entries: [{ name: "nested", path: "my-repo/nested", is_git_repo: false }],
          });
        }
        return HttpResponse.json({
          path: "",
          is_git_repo: false,
          entries: [{ name: "my-repo", path: "my-repo", is_git_repo: true }],
        });
      }),
    );

    // A stateful harness so "Use this folder" actually threads form.directory back.
    const Harness: FC = () => {
      const [directory, setDirectory] = useState("");
      return <LandingHero form={createForm({ directory, setDirectory })} />;
    };
    render(<Harness />);

    expect(screen.getByRole("button", { name: "create session" })).toBeDisabled();

    fireEvent.click(await screen.findByRole("button", { name: "Open my-repo" }));
    await screen.findByRole("button", { name: "Open nested" }); // wait for the re-list
    fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));

    expect(await screen.findByRole("button", { name: "create session" })).toBeEnabled();
  });
});
