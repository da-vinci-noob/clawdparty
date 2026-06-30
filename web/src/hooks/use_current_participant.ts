// Exposes the current participant (and a roleCan helper) for client-side role
// gating. PRESENTATION ONLY — the server SessionPolicy is the authoritative gate;
// this just hides buttons a role can't use.

import { type CurrentParticipant, roleCan, useParticipantStore } from "../stores/participant_store";

export function useCurrentParticipant(): {
  participant: CurrentParticipant | null;
  can: (action: string) => boolean;
} {
  const participant = useParticipantStore((s) => s.current);
  return { participant, can: (action: string) => roleCan(participant?.role, action) };
}
