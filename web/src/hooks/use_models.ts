// Models the host can actually serve, from GET /api/models (Rails proxies the harness's
// per-provider discovery verbatim).
//
// SHAPE: `{ providers: ProviderStatus[] }`. It used to be `{ models, source }`, and this hook
// was still reading the old shape after the harness moved to the new one — so `data.source`
// was undefined, the gate below rejected everything, and the picker silently offered nothing
// but "Default model". Both test suites passed the whole time: the web tests mocked the old
// shape and the harness tests asserted the new one, and nothing exercised the seam. Hence
// `providers_shape` in the tests, which asserts against the real contract type.
//
// Only models from an AVAILABLE provider are offered. A Bedrock id is an
// account-specific inference profile, so an id that was not discovered on THIS host may not
// resolve at all — offering one produces a run that dies at dispatch instead of a picker that
// explains itself.

import type { ProviderStatus } from "@clawdparty/contracts";
import { useQuery } from "@tanstack/react-query";

export interface ModelInfo {
  id: string;
  label: string;
  // The model's native context window in tokens (the CONTEXT bar's denominator).
  context_window: number;
  /** Which provider serves it — the picker groups on this, and a run records it. */
  provider: string;
  providerLabel: string;
  /**
   * Whether tools may be offered on a STREAMING request. False for 8 of 18 non-Anthropic
   * Bedrock models, which accept a tool request or a streamed response but not both — the
   * loop refuses such a run, so the picker has to say so before it is chosen.
   */
  toolUseWhileStreaming: boolean;
}

interface ProviderList {
  providers?: ProviderStatus[];
}

async function fetchProviders(): Promise<ProviderList> {
  try {
    const res = await fetch("/api/models", {
      headers: { accept: "application/json" },
      credentials: "include",
    });
    // A non-OK response is indistinguishable from "no providers" for the picker's purpose,
    // and it must not throw: the composer stays usable with the server default.
    if (!res.ok) return { providers: [] };
    return (await res.json()) as ProviderList;
  } catch {
    return { providers: [] };
  }
}

function toModels(providers: ProviderStatus[]): ModelInfo[] {
  return (
    providers
      // The gate. An unavailable provider still arrives — reported with a reason, never
      // omitted  — and its `models` array is empty, but filtering on `available`
      // rather than on emptiness keeps the intent legible.
      .filter((provider) => provider.available)
      .flatMap((provider) =>
        provider.models.map((model) => ({
          id: model.id,
          label: model.displayName,
          // The REAL per-model window, from the provider. Previously a family-name guess in
          // `models.ts`, which silently returned 200K for anything it did not recognise —
          // and this number is the denominator of the live context bar.
          context_window: model.capabilities.contextWindow,
          provider: provider.id,
          providerLabel: provider.displayName,
          toolUseWhileStreaming: model.capabilities.toolUseWhileStreaming,
        })),
      )
  );
}

/**
 * Every model this host can serve, flattened across available providers.
 *
 * Empty while loading and when discovery fails, which is what makes the composer's
 * "Default model" option load-bearing rather than decorative.
 */
export function useModels(): ModelInfo[] {
  const { data } = useQuery({
    queryKey: ["models"],
    queryFn: fetchProviders,
    staleTime: 60_000,
  });
  return toModels(data?.providers ?? []);
}

/**
 * Providers that cannot serve, with the reason and the fix.
 *
 * Exposed so the composer can SHOW them instead of leaving a participant with an
 * empty picker and no explanation — the failure  were written against.
 */
export function useUnavailableProviders(): Array<{
  id: string;
  label: string;
  reason?: string;
  remedy?: string;
}> {
  const { data } = useQuery({
    queryKey: ["models"],
    queryFn: fetchProviders,
    staleTime: 60_000,
  });
  return (data?.providers ?? [])
    .filter((provider) => !provider.available)
    .map((provider) => ({
      id: provider.id,
      label: provider.displayName,
      reason: provider.reason,
      remedy: provider.remedy,
    }));
}
