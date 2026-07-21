// Fetches the models available to the host's Claude/Bedrock login from
// GET /api/models (proxied from the sidecar, discovered at runtime). On Bedrock the
// ids are inference-profile ids (e.g. "global.anthropic.claude-opus-4-8") — exactly
// what run start needs.
//
// IMPORTANT: only models the sidecar actually DISCOVERED (source "bedrock" or
// "anthropic") are safe to run. A hardcoded plain id like "claude-opus-4-8" is
// invalid on Bedrock (which requires the inference-profile id), so we never offer a
// static fallback in the picker — until discovery resolves (and if it fails), the
// only choice is "Default model" (the server's configured model), which always works.

import { useQuery } from "@tanstack/react-query";

export interface ModelInfo {
  id: string;
  label: string;
  // The model's native context window in tokens (the CONTEXT bar's denominator).
  context_window: number;
}

interface ModelList {
  models: ModelInfo[];
  source?: string;
  error?: string;
}

// Only these sources are real, host-valid discoveries; "fallback"/loading/errors
// carry ids that may not resolve for this login, so the picker ignores them.
const REAL_SOURCES = new Set(["bedrock", "anthropic"]);

async function fetchModels(): Promise<ModelList> {
  try {
    const res = await fetch("/api/models", {
      headers: { accept: "application/json" },
      credentials: "include",
    });
    if (!res.ok) {
      return { models: [], source: "unavailable" };
    }
    return (await res.json()) as ModelList;
  } catch {
    return { models: [], source: "unavailable" };
  }
}

// The discovered, host-valid models (empty while loading or if discovery failed).
// Consumers pair this with a "Default model" option that uses the server default.
export function useModels(): ModelInfo[] {
  const { data } = useQuery({
    queryKey: ["models"],
    queryFn: fetchModels,
    staleTime: 60_000,
  });
  return data?.source && REAL_SOURCES.has(data.source) ? data.models : [];
}
