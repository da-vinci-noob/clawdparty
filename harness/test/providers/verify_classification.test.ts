import { describe, expect, it } from "vitest";
import type { ProviderAdapter } from "../../src/providers/contract.js";
import { verifyProviders } from "../../src/providers/verify.js";

/**
 * `POST /verify` is the one failure path that hands back unclassified vendor JSON.
 *
 * Everywhere else, a failure is classified and given a remedy: `listProviders` does it for discovery,
 * and the loop does it mid-run through `classifyStreamError` (`[failure-hints]`). But when the
 * credential is GOOD and the request itself fails, `verify` returned only `error: err.message`.
 *
 * Found live, on the credential this host just gained: a subscription token accepted for the Models
 * API answered a real message request with
 *
 *   429 {"type":"error","error":{"type":"rate_limit_error","message":"Error"},"request_id":"req_…"}
 *
 * The vendor's `message` is literally the word "Error". So the field meant to carry the diagnostic
 * carried nothing, and the participant sees raw JSON with no statement of what to do — while the
 * harness already knows that a 429 means "wait and retry".  wants the actionable part named.
 *
 * `error` is KEPT: it holds the `request_id`, which is the one thing a vendor support conversation
 * needs and which no classifier can reconstruct.
 */

const CAPS = {
  streaming: true,
  toolUse: true,
  toolUseWhileStreaming: true,
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  adaptiveThinking: false,
  thinkingBudgetTokens: null,
  thinkingDisplaySummarized: false,
  effortLevels: [],
  promptCaching: false,
  minCacheablePrefixTokens: null,
  serverSideCompaction: false,
  contextEditing: false,
  serverSideTools: { webSearch: false, webFetch: false, codeExecution: false },
  liveModelDiscovery: true,
  serverSideRefusalFallback: true,
  midConversationSystemMessages: true,
  midConversationToolChanges: true,
};

/** An adapter whose credential is fine and whose request throws with `status`. */
function failing(status: number, message: string): ProviderAdapter {
  return {
    id: "throttled",
    displayName: "Throttled provider",
    entitlement: { credentialKind: "subscription", thirdPartyClientPermitted: "yes", note: "t" },
    failureHints: {
      expired: "re-auth hint",
      notEntitled: "entitlement hint",
      unreachable: "network hint",
    },
    async probe() {
      return { available: true, credentialSource: "keychain:anthropic-oauth" as const };
    },
    async listModels() {
      return [{ id: "claude-opus-5", displayName: "Opus", capabilities: CAPS }];
    },
    capabilities() {
      return CAPS;
    },
    // NOT a generator: this one only ever throws, and a generator with no `yield` is a lie about
    // its own shape. The adapter contract is satisfied either way — the loop awaits the iterable.
    stream() {
      throw Object.assign(new Error(message), { status });
    },
  } as unknown as ProviderAdapter;
}

const RATE_LIMIT =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"Error"},"request_id":"req_011Ce8"}';

async function verifyOne(adapter: ProviderAdapter) {
  const { providers } = await verifyProviders([adapter]);
  const result = providers[0];
  if (!result) throw new Error("verifyProviders returned no row");
  return result;
}

describe("a request failure on a GOOD credential is classified", () => {
  it("names the reason for a 429 instead of only echoing the vendor", async () => {
    const result = await verifyOne(failing(429, RATE_LIMIT));

    expect(result.ok).toBe(false);
    // "the credential works, the request was throttled" — not "something went wrong".
    expect(result.reason).toBe("api_error");
    expect(result.remedy).toMatch(/rate limit|wait|retry/i);
  });

  it("keeps the vendor's own text, because it carries the request_id", async () => {
    const result = await verifyOne(failing(429, RATE_LIMIT));

    // The classifier cannot invent `req_011Ce8`, and it is the only thing a support thread needs.
    expect(result.error).toContain("req_011Ce8");
  });

  it("distinguishes an expired credential from a throttled one", async () => {
    const result = await verifyOne(failing(401, "401 unauthorized"));

    expect(result.reason).toBe("credential_expired");
    expect(result.remedy).toBe("re-auth hint");
  });

  it("distinguishes an UNENTITLED credential, which re-authenticating would not fix", async () => {
    const result = await verifyOne(failing(403, "403 forbidden"));

    expect(result.reason).toBe("not_entitled");
    expect(result.remedy).toBe("entitlement hint");
  });

  it("still reports the credential SOURCE on a failure, so the right one is being blamed", async () => {
    const result = await verifyOne(failing(429, RATE_LIMIT));

    expect(result.credentialSource).toBe("keychain:anthropic-oauth");
  });
});
