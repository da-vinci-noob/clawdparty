// The caller's session history from GET /api/sessions — every session they host
// or joined, newest activity first (see the session-history capability). The
// endpoint is gated by the clawd_uid cookie; a visitor without one gets 404, so
// the list simply resolves empty. Also exposes an archive mutation (owner-only
// server-side) that hard-closes a session and refetches the list.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Role } from "../stores/participant_store";

export interface SessionSummary {
  id: string;
  title: string;
  mode: "review" | "chat";
  status: "active" | "archived";
  my_role: Role | null;
  // Whether the caller is the session's host — the client splits the list into
  // "Your sessions" (owned) and "Joined" (not owned).
  owned: boolean;
  last_activity_at: string | null;
  created_at: string;
}

const SESSIONS_KEY = ["sessions"] as const;

async function fetchSessions(): Promise<SessionSummary[]> {
  const res = await fetch("/api/sessions", {
    headers: { accept: "application/json" },
    credentials: "include",
  });
  // 404 = no valid cookie (anti-enumeration via require_user): a fresh visitor
  // simply has no history. Treat any non-OK response as an empty list rather
  // than an error, so the marketing page renders unaffected.
  if (!res.ok) {
    return [];
  }
  return (await res.json()) as SessionSummary[];
}

export function useSessions(): SessionSummary[] {
  const { data } = useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: fetchSessions,
    staleTime: 10_000,
  });
  return data ?? [];
}

async function archiveSession(id: string): Promise<void> {
  const res = await fetch(`/api/sessions/${id}/archive`, {
    method: "POST",
    headers: { accept: "application/json" },
    credentials: "include",
  });
  if (!res.ok) {
    const parsed = (await res.json().catch(() => null)) as {
      errors?: { message: string }[];
    } | null;
    throw new Error(parsed?.errors?.[0]?.message ?? `Archive failed (${res.status})`);
  }
}

export function useArchiveSession(): (id: string) => void {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: archiveSession,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SESSIONS_KEY }),
  });
  return mutation.mutate;
}
