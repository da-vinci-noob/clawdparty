import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RenderResult, render } from "@testing-library/react";
import type { ReactElement } from "react";

// Render a component tree that reads TanStack Query (e.g. anything using
// useModels) inside a fresh QueryClient — retries off so failing fetches don't
// linger between tests.
export function renderWithQuery(ui: ReactElement): RenderResult {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}
