// REST backfill fetch for the gap-free catch-up. Returns the ordered ascending-id
// envelopes with id > cursor, scoped to the session. The signed clawd_uid cookie
// authenticates the request (sent automatically; credentials: "include").

import type { EventEnvelope } from "@clawdparty/contracts";

// A 404 from the backfill means the session does not exist OR the requester is
// not a participant (the server returns 404 for both — anti-enumeration). It is a
// terminal "no access" signal, distinct from a transient failure, so callers
// route it to a not-found state rather than silently retrying forever.
export class BackfillNotFound extends Error {}

export async function fetchBackfill(sessionId: string, afterId: number): Promise<EventEnvelope[]> {
  const res = await fetch(`/api/sessions/${sessionId}/events?after=${afterId}`, {
    headers: { accept: "application/json" },
    credentials: "include",
  });
  if (res.status === 404) {
    throw new BackfillNotFound(`session ${sessionId} not found or not joined`);
  }
  if (!res.ok) {
    throw new Error(`backfill failed: ${res.status}`);
  }
  return (await res.json()) as EventEnvelope[];
}
