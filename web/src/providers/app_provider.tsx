import type { FC, ReactNode } from "react";
import { ErrorBoundary } from "../components/error_boundary";

interface Props {
  children: ReactNode;
}

// The single nested provider-composition seam. W2 wires feature providers
// (TanStack Query client, cable connection context, Zustand stores) HERE — none
// is wired to data in this scaffold.
export const AppProvider: FC<Props> = ({ children }) => <ErrorBoundary>{children}</ErrorBoundary>;
