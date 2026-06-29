import { QueryClient } from "@tanstack/react-query";

// One shared TanStack Query client for fetched resources. W1 wired no data; the
// cable-client uses it for the REST event backfill. Sensible defaults for a
// live-collaboration app: don't refetch the backfill on window focus (the cable
// stream is the live source; backfill is a one-shot catch-up).
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
