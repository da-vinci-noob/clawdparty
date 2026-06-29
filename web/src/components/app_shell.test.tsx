import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppShell } from "./app_shell";

describe("AppShell", () => {
  it("renders the three workspace regions", () => {
    render(<AppShell />);
    expect(screen.getByRole("complementary", { name: /sessions sidebar/i })).toBeInTheDocument();
    expect(screen.getByRole("main", { name: /activity tabs/i })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: /chat sidebar/i })).toBeInTheDocument();
  });

  it("renders its children in the center region", () => {
    render(
      <AppShell>
        <span>center content</span>
      </AppShell>,
    );
    expect(screen.getByText("center content")).toBeInTheDocument();
  });
});
