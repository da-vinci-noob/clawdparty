// The auth test: does each provider actually work, right now?
//
// A MUTATION, not a query, and deliberately not cached or run on mount: each call sends a real
// (tiny) request to every provider, and the reason to open this tab is that something just changed
// — an expired `aws sso login`, a new profile. A cached verdict answers the question nobody asked.
//
// This is what `GET /api/models` cannot tell you. That endpoint reports PRESENCE (a credential and
// a region were found), and presence is not acceptance: measured on this host, `nova-premier`
// refuses a valid-looking credential on entitlement, and a correctly-configured MCP server answered
// `invalid_token`.

import { useMutation, useQueryClient } from "@tanstack/react-query";

export interface ProviderVerdict {
  id: string;
  displayName: string;
  ok: boolean;
  /** The model the request actually went to. */
  model?: string;
  /** Where the credential came from — a NAME, never a value. */
  credentialSource?: string;
  /** Why it was not even attempted (no credential, no models, unknown model). */
  reason?: string;
  remedy?: string;
  /** The provider's own refusal message, which is the diagnostic. */
  error?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  durationMs?: number;
}

async function verify(): Promise<ProviderVerdict[]> {
  const res = await fetch("/api/providers/verify", {
    method: "POST",
    headers: { accept: "application/json" },
    credentials: "include",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { errors?: { message: string }[] } | null;
    throw new Error(body?.errors?.[0]?.message ?? `Request failed (${res.status})`);
  }
  return ((await res.json()) as { providers?: ProviderVerdict[] }).providers ?? [];
}

export function useProviderVerification(): {
  verdicts: ProviderVerdict[] | null;
  run: () => void;
  running: boolean;
  error: string | null;
} {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: verify,
    /**
     * Refresh DISCOVERY once the test lands, because the test is the better information.
     *
     * Discovery is a cached snapshot — Rails holds `/api/models` for 60s — while a verdict comes from
     * a real request just sent. Without this the two live in different generations and the panel can
     * show a provider as UNAVAILABLE next to VERIFIED, which was screenshotted from the running app:
     * Bedrock Converse, with a credential and a successful 22-in/3-out test, badged unavailable. Both
     * cannot be true, and the one backed by an actual request is the one to believe.
     */
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["models"] });
    },
  });
  return {
    verdicts: mutation.data ?? null,
    run: () => mutation.mutate(),
    running: mutation.isPending,
    error: mutation.error ? mutation.error.message : null,
  };
}
