import { QueryClientProvider } from "@tanstack/react-query";
import type { FC, ReactNode } from "react";
import { ErrorBoundary } from "../components/error_boundary";
import { ActionCableProvider, type ConsumerFactory } from "../lib/action_cable_provider";
import { queryClient } from "../lib/query_client";

interface Props {
  children: ReactNode;
  // Injectable for tests (a fake consumer); production uses the default /~cable consumer.
  consumerFactory?: ConsumerFactory;
}

// The single nested provider-composition seam. Now wires the TanStack Query
// client (REST backfill) and the ActionCable provider (live cable) on top of the
// W1 error boundary. Feature stores/providers continue to compose here.
export const AppProvider: FC<Props> = ({ children, consumerFactory }) => (
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <ActionCableProvider consumerFactory={consumerFactory}>{children}</ActionCableProvider>
    </QueryClientProvider>
  </ErrorBoundary>
);
