import type { ProviderCapabilities, ProviderStatus } from "@clawdparty/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { server } from "../../test/msw_server";
import { useModels, useUnavailableProviders } from "./use_models";

/**
 * a participant is only offered models the host can actually serve.
 *
 * This file exists because of a break that BOTH suites missed: the harness moved
 * `GET /models` to the per-provider shape, this hook still read `{ models, source }`, and the
 * gate rejected everything — so the picker silently offered nothing but "Default model". The
 * harness tests asserted the new shape, the web tests mocked the old one, and nothing
 * exercised the seam between them.
 *
 * So every fixture here is TYPED as `ProviderStatus` from the shared contract. A field the
 * server renames now fails to compile on this side, which is stronger than any runtime
 * assertion: the drift cannot reach a green build.
 */

const CAPS: ProviderCapabilities = {
  streaming: true,
  toolUse: true,
  toolUseWhileStreaming: true,
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
  adaptiveThinking: true,
  thinkingBudgetTokens: null,
  thinkingDisplaySummarized: true,
  effortLevels: [],
  promptCaching: true,
  minCacheablePrefixTokens: 512,
  serverSideCompaction: false,
  contextEditing: false,
  serverSideTools: { webSearch: true, webFetch: true, codeExecution: true },
  liveModelDiscovery: true,
  serverSideRefusalFallback: true,
  midConversationSystemMessages: true,
  midConversationToolChanges: true,
};

const DIRECT: ProviderStatus = {
  id: "anthropic-direct",
  displayName: "Anthropic (direct)",
  available: true,
  credentialSource: "env:ANTHROPIC_API_KEY",
  models: [
    {
      id: "claude-opus-5",
      displayName: "Claude Opus 5",
      capabilities: { ...CAPS, contextWindow: 1_000_000 },
    },
  ],
};

const BEDROCK_UNAVAILABLE: ProviderStatus = {
  id: "anthropic-bedrock",
  displayName: "Amazon Bedrock",
  available: false,
  reason: "unreachable",
  remedy: "Run `aws sso login` — the harness cannot refresh an expired SSO session.",
  models: [],
};

function serve(providers: ProviderStatus[]): void {
  server.use(http.get("/api/models", () => HttpResponse.json({ providers })));
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useModels reads the per-provider shape", () => {
  it("flattens available providers into pickable models", async () => {
    serve([DIRECT]);

    const { result } = renderHook(() => useModels(), { wrapper });

    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0]).toMatchObject({
      id: "claude-opus-5",
      label: "Claude Opus 5",
      provider: "anthropic-direct",
      providerLabel: "Anthropic (direct)",
    });
  });

  it("uses the provider's REAL per-model context window", async () => {
    serve([DIRECT]);

    const { result } = renderHook(() => useModels(), { wrapper });

    // This number is the denominator of the live context bar. It used to be guessed from
    // substring-matching the model id against a hardcoded family list, which returned 200K
    // for anything unrecognised — so a new 1M model silently showed 5x the real pressure.
    await waitFor(() => expect(result.current[0]?.context_window).toBe(1_000_000));
  });

  it("offers NOTHING from an unavailable provider", async () => {
    serve([BEDROCK_UNAVAILABLE]);

    const { result } = renderHook(() => useModels(), { wrapper });

    // A Bedrock id is an account-specific inference profile, so offering one that
    // was not discovered on THIS host produces a run that dies at dispatch rather than a
    // picker that explains itself.
    await waitFor(() => expect(result.current).toEqual([]));
  });

  it("offers the available provider's models while excluding the unavailable one's", async () => {
    serve([DIRECT, BEDROCK_UNAVAILABLE]);

    const { result } = renderHook(() => useModels(), { wrapper });

    // The mixed case is the real one: a host with an API key and a stale AWS session. The
    // picker must stay useful rather than failing closed on the broken provider.
    await waitFor(() =>
      expect(result.current.map((m) => m.provider)).toEqual(["anthropic-direct"]),
    );
  });

  it("is empty — not broken — when the endpoint fails", async () => {
    server.use(http.get("/api/models", () => new HttpResponse(null, { status: 502 })));

    const { result } = renderHook(() => useModels(), { wrapper });

    // The composer pairs this with a "Default model" option, so empty degrades to the
    // server default instead of blocking the session.
    await waitFor(() => expect(result.current).toEqual([]));
  });

  it("is empty when the response carries no providers key at all", async () => {
    // Exactly the break this file was written for: an OLD-shape response. It must yield
    // nothing rather than throwing on `providers.filter`.
    server.use(
      http.get("/api/models", () => HttpResponse.json({ models: [], source: "anthropic" })),
    );

    const { result } = renderHook(() => useModels(), { wrapper });

    await waitFor(() => expect(result.current).toEqual([]));
  });
});

describe("useUnavailableProviders surfaces the reason", () => {
  it("reports an unavailable provider with its remedy", async () => {
    serve([DIRECT, BEDROCK_UNAVAILABLE]);

    const { result } = renderHook(() => useUnavailableProviders(), { wrapper });

    // reported, never omitted. An empty picker with no explanation is the
    // failure those requirements were written against.
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0]).toMatchObject({
      id: "anthropic-bedrock",
      label: "Amazon Bedrock",
      reason: "unreachable",
    });
    expect(result.current[0]?.remedy).toMatch(/aws sso login/);
  });

  it("reports nothing when every provider is available", async () => {
    serve([DIRECT]);

    const { result } = renderHook(() => useUnavailableProviders(), { wrapper });

    await waitFor(() => expect(result.current).toEqual([]));
  });
});
