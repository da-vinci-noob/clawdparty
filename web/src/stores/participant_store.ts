// The current participant for the joined session. Set by the join flow (the
// /api/participants response) — the clawd_uid cookie is httpOnly, so the client
// never reads it; it tracks "who am I" from the join response. Role-gating in the
// UI reads from here (presentation only; the server SessionPolicy is the gate).

import { create } from "zustand";

export type Role = "owner" | "editor" | "reviewer" | "viewer";

export interface CurrentParticipant {
  id: string;
  session_id: string;
  role: Role;
  name: string;
}

interface ParticipantStoreState {
  current: CurrentParticipant | null;
  setCurrent: (participant: CurrentParticipant) => void;
  clear: () => void;
}

export const useParticipantStore = create<ParticipantStoreState>((set) => ({
  current: null,
  setCurrent: (participant) => set({ current: participant }),
  clear: () => set({ current: null }),
}));

// Presentation-only capability check, mirroring the frozen 4-role matrix. The
// server enforces; this only hides buttons.
const MATRIX: Record<Role, Set<string>> = {
  owner: new Set([
    "view",
    "chat",
    "manage_tasks",
    "run",
    "interrupt",
    "approve",
    "reject",
    "manage_invites",
    "manage_session",
    "bypass_permissions",
  ]),
  editor: new Set(["view", "chat", "manage_tasks", "run", "interrupt"]),
  reviewer: new Set(["view", "chat", "manage_tasks"]),
  viewer: new Set(["view", "chat"]),
};

export function roleCan(role: Role | undefined, action: string): boolean {
  if (!role) {
    return false;
  }
  return MATRIX[role].has(action);
}
