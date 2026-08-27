// The per-session run defaults — what a run starts with when the composer is left alone.
//
// Owner-only on the server (`manage_session`); the AWS profile especially, because it decides whose
// account pays. Invalidates the session query on success so the page shows what is stored
// rather than what was typed.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface SessionDefaults {
  default_provider?: string | null;
  default_model?: string | null;
  aws_profile?: string | null;
}

/** AWS profile NAMES the host has. Never a credential value. */
export function useAwsProfiles(): string[] {
  const { data } = useQuery({
    queryKey: ["aws-profiles"],
    queryFn: async () => {
      const res = await fetch("/api/aws-profiles", {
        headers: { accept: "application/json" },
        credentials: "include",
      });
      // An unreachable harness must not break the tab: the rest of it is still usable, and the
      // select simply has nothing to offer.
      if (!res.ok) {
        return { profiles: [] as string[] };
      }
      return (await res.json()) as { profiles?: string[] };
    },
    staleTime: 60_000,
  });
  return data?.profiles ?? [];
}

export function useSaveSessionDefaults(sessionId: string): {
  save: (defaults: SessionDefaults) => Promise<void>;
  busy: boolean;
  error: string | null;
  saved: boolean;
} {
  const queries = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (defaults: SessionDefaults) => {
      const res = await fetch(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "include",
        // Only the keys being set. The endpoint leaves the working directory alone unless
        // `repository_path` is present, and this must not send it.
        body: JSON.stringify(defaults),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          errors?: { message: string }[];
        } | null;
        // The server's message names the actual problem ("anthropic-bedrock does not serve model
        // X"), which is more useful than a status code.
        throw new Error(body?.errors?.[0]?.message ?? `Update failed (${res.status})`);
      }
    },
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ["session", sessionId] });
    },
  });

  return {
    save: (defaults) => mutation.mutateAsync(defaults),
    busy: mutation.isPending,
    error: mutation.error ? mutation.error.message : null,
    saved: mutation.isSuccess,
  };
}
