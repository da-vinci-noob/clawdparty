// Resolve an actor.id (a participant id) to a display name, per the frozen
// event-envelope rule: the event carries the id, not the name; names are
// resolved client-side. Falls back to a short id when the name is not yet
// locally known (never blocks rendering on resolution).

import type { Actor } from "@clawdparty/contracts";

export type ParticipantNames = Map<string, string>;

export function actorLabel(actor: Actor, names: ParticipantNames): string {
  if (actor.kind === "claude") {
    return "Claude";
  }
  if (actor.kind === "system") {
    return "system";
  }
  return names.get(actor.id) ?? `#${actor.id}`;
}
