import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RenderResult, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";

// Render a component tree that reads TanStack Query (e.g. anything using useModels) inside a fresh
// QueryClient — retries off so failing fetches don't linger between tests.
//
// A MemoryRouter is included because components in this app link to other routes (the session's
// settings link, the session list), and a bare render throws inside <Link> with an error that names
// the component rather than the missing context. Tests that need a specific location pass one.
export function renderWithQuery(ui: ReactElement, route = "/"): RenderResult {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The same tree, entered at a specific route — for rendering `AppRoutes` at a URL. */
export function renderWithRouterAt(ui: ReactElement, route: string): RenderResult {
  return renderWithQuery(ui, route);
}
