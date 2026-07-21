// Re-hydrate the current participant (role/name) for a session from the server.
// The participant store is in-memory (Zustand) and is lost on a page refresh,
// while the signed httpOnly clawd_uid cookie persists — so after a refresh the
// role-gated UI (composer, interrupt, invite) would vanish. On mount, if the
// store has no current participant for THIS session, fetch it from
// GET /api/sessions/:id/participant (cookie-authenticated) and populate the store.
//
// The store is GLOBAL, so navigating between sessions (now possible via the
// session list) can leave a STALE participant from the previous session — with a
// different, possibly higher, role. Role-gated UI (e.g. the owner-only
// InvitePanel) would then render and fire owner-only requests against the new
// session, which the server rejects (403). So when the store points at a
// different session, clear it FIRST and only render role-gated UI once the real
// role for THIS session is confirmed.

import { useEffect } from "react";
import { type CurrentParticipant, useParticipantStore } from "../stores/participant_store";

export function useHydrateParticipant(sessionId: string): void {
  useEffect(() => {
    const current = useParticipantStore.getState().current;
    if (current && current.session_id === sessionId) {
      return; // already know who we are in this session
    }
    if (current) {
      // Stale participant from a DIFFERENT session — drop it so no role-gated UI
      // renders with the wrong role while we confirm this session's role.
      useParticipantStore.getState().clear();
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
        // Transient network error — leave the store cleared; a reconnect re-runs mount.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);
}
