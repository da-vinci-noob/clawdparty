// REST backfill fetch for the gap-free catch-up. Returns the ordered ascending-id
// envelopes with id > cursor, scoped to the session. The signed clawd_uid cookie
// authenticates the request (sent automatically; credentials: "include").

import type { EventEnvelope } from "@clawdparty/contracts";

export async function fetchBackfill(sessionId: string, afterId: number): Promise<EventEnvelope[]> {
  const res = await fetch(`/api/sessions/${sessionId}/events?after=${afterId}`, {
    headers: { accept: "application/json" },
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`backfill failed: ${res.status}`);
  }
  return (await res.json()) as EventEnvelope[];
}
