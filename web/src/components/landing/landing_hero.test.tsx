import { render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
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
});
