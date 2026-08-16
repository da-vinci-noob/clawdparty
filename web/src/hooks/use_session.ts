// One session's configuration from GET /api/sessions/:id — the `mode` and working
// directory. Separate from useSessions (the caller's history list) because the session
// VIEW needs the mode of the session it is displaying, and reading it out of the history
// list would make the page depend on a list it does not otherwise render.
//
// `mode` decides whether a review affordance applies at all: a chat session has no
// worktree and never enters `awaiting_review`, so approve/reject can never appear.
//
// Not cached indefinitely even though `mode` is fixed for a session's lifetime:
// `repository_path` is not — an owner can change it mid-session (PATCH /api/sessions/:id).

import { useQuery } from "@tanstack/react-query";

export interface SessionConfig {
  id: string;
  mode: "review" | "chat";
  repository_path: string | null;
}

async function fetchSession(sessionId: string): Promise<SessionConfig | null> {
  const res = await fetch(`/api/sessions/${sessionId}`, {
    headers: { accept: "application/json" },
    credentials: "include",
  });
  // 404 = not a participant, or no valid cookie (anti-enumeration). Null rather than a
  // throw: callers must render nothing, not an error — the mode is unknown, and guessing
  // either way shows the wrong affordance.
  if (!res.ok) {
    return null;
  }
  return (await res.json()) as SessionConfig;
}

export function useSession(sessionId: string): SessionConfig | null {
  const { data } = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => fetchSession(sessionId),
    enabled: sessionId !== "",
  });
  return data ?? null;
}
