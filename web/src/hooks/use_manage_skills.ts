// Adding and removing host skills. Owner-only on the server (`manage_session`); this hook
// exists for the settings tab, and the client only hides buttons.
//
// Invalidates the skills query on success, because the popover's count and the settings list are the
// same data and a stale count after an add is the kind of small lie that makes a surface untrusted.

import { useMutation, useQueryClient } from "@tanstack/react-query";

export type SkillScope = "project" | "host";

export interface AddSkillInput {
  scope: SkillScope;
  name: string;
  description: string;
  body: string;
  /** Replacing an existing skill has to be asked for; the server refuses otherwise. */
  replace?: boolean;
}

async function send(sessionId: string, input: AddSkillInput): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/skills`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  await throwOnError(res);
}

async function remove(sessionId: string, name: string, scope: SkillScope): Promise<void> {
  const res = await fetch(
    `/api/sessions/${sessionId}/skills/${encodeURIComponent(name)}?scope=${scope}`,
    { method: "DELETE", headers: { accept: "application/json" }, credentials: "include" },
  );
  await throwOnError(res);
}

async function throwOnError(res: Response): Promise<void> {
  if (res.ok) {
    return;
  }
  // The server's message is the actionable part ("use a short lowercase name", "already exists"),
  // so it is surfaced rather than replaced with a status code.
  const body = (await res.json().catch(() => null)) as { errors?: { message: string }[] } | null;
  throw new Error(body?.errors?.[0]?.message ?? `Request failed (${res.status})`);
}

export function useManageSkills(sessionId: string): {
  add: (input: AddSkillInput) => Promise<void>;
  removeSkill: (name: string, scope: SkillScope) => Promise<void>;
  busy: boolean;
  error: string | null;
  clearError: () => void;
} {
  const queries = useQueryClient();
  const invalidate = () => {
    void queries.invalidateQueries({ queryKey: ["skills", sessionId] });
  };

  const adding = useMutation({
    mutationFn: (input: AddSkillInput) => send(sessionId, input),
    onSuccess: invalidate,
  });
  const removing = useMutation({
    mutationFn: ({ name, scope }: { name: string; scope: SkillScope }) =>
      remove(sessionId, name, scope),
    onSuccess: invalidate,
  });

  const error = adding.error ?? removing.error;
  return {
    add: (input) => adding.mutateAsync(input),
    removeSkill: (name, scope) => removing.mutateAsync({ name, scope }),
    busy: adding.isPending || removing.isPending,
    error: error ? error.message : null,
    clearError: () => {
      adding.reset();
      removing.reset();
    },
  };
}
