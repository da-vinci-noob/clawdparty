// Fetches the models available to the host's Claude/Bedrock login from
// GET /api/models (proxied from the sidecar, discovered at runtime). Falls back
// to a small static list so the picker always has options even before the fetch
// resolves or if discovery fails server-side. On Bedrock the ids are inference-
// profile ids (e.g. "us.anthropic.claude-opus-4-8") — exactly what run start needs.

import { useQuery } from "@tanstack/react-query";

export interface ModelInfo {
  id: string;
  label: string;
}

interface ModelList {
  models: ModelInfo[];
  source?: string;
  error?: string;
}

// Mirrors the sidecar's FALLBACK_MODELS; used as initialData so the dropdown is
// never empty during the first fetch.
export const FALLBACK_MODELS: ModelInfo[] = [
  { id: "claude-opus-4-8", label: "Claude Opus 4.8 (most capable)" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5 (balanced)" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (fastest)" },
];

async function fetchModels(): Promise<ModelInfo[]> {
  const res = await fetch("/api/models", {
    headers: { accept: "application/json" },
    credentials: "include",
  });
  if (!res.ok) {
    return FALLBACK_MODELS;
  }
  const body = (await res.json()) as ModelList;
  return body.models?.length ? body.models : FALLBACK_MODELS;
}

export function useModels(): ModelInfo[] {
  const { data } = useQuery({
    queryKey: ["models"],
    queryFn: fetchModels,
    // placeholderData (not initialData) so the dropdown shows the fallback list
    // immediately AND a real discovery fetch still fires on mount.
    placeholderData: FALLBACK_MODELS,
    staleTime: 60_000,
  });
  return data ?? FALLBACK_MODELS;
}
