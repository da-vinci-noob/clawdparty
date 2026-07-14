import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppRoutes } from "./routes";

describe("AppRoutes", () => {
  it("resolves the landing route to its placeholder", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("landing-placeholder")).toBeInTheDocument();
  });

  it("resolves the session route to its placeholder shell", () => {
    render(
      <MemoryRouter initialEntries={["/sessions/abc"]}>
        <AppRoutes />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("session-placeholder")).toBeInTheDocument();
  });
});
