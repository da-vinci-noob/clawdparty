// Re-hydrate the current participant (role/name) for a session from the server.
// The participant store is in-memory (Zustand) and is lost on a page refresh,
// while the signed httpOnly clawd_uid cookie persists — so after a refresh the
// role-gated UI (composer, interrupt, invite) would vanish. On mount, if the
// store has no current participant for THIS session, fetch it from
// GET /api/sessions/:id/participant (cookie-authenticated) and populate the store.

import { useEffect } from "react";
import { type CurrentParticipant, useParticipantStore } from "../stores/participant_store";

export function useHydrateParticipant(sessionId: string): void {
  useEffect(() => {
    const current = useParticipantStore.getState().current;
    if (current && current.session_id === sessionId) {
      return; // already know who we are in this session
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/participant`, {
          headers: { accept: "application/json" },
          credentials: "include",
        });
        if (!res.ok) {
          return; // not a participant / not found — the page's not-found path handles it
        }
        const participant = (await res.json()) as CurrentParticipant;
        if (!cancelled) {
          useParticipantStore.getState().setCurrent(participant);
        }
      } catch {
        // Transient network error — leave the store as-is; a reconnect re-runs mount.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);
}
