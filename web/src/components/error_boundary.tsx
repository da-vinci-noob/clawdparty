import type { FC, ReactNode } from "react";
import { type FallbackProps, ErrorBoundary as ReactErrorBoundary } from "react-error-boundary";

const Fallback: FC<FallbackProps> = ({ error }) => (
  <div role="alert" className="p-4 text-red-700">
    <h2 className="font-semibold">Something went wrong.</h2>
    <pre className="mt-2 whitespace-pre-wrap text-sm">{String(error)}</pre>
  </div>
);

interface Props {
  children: ReactNode;
}

// App-wide error boundary (react-error-boundary, no Sentry wiring in the MVP).
export const ErrorBoundary: FC<Props> = ({ children }) => (
  <ReactErrorBoundary FallbackComponent={Fallback}>{children}</ReactErrorBoundary>
);
