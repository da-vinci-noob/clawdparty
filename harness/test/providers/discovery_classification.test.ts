import { describe, expect, it } from "vitest";
import { AnthropicBedrockAdapter } from "../../src/providers/anthropic_bedrock.js";
import { classifyProbeFailure, classifyStreamError } from "../../src/providers/anthropic_family.js";
import { listProviders } from "../../src/providers/discovery.js";

/**
 * An expired credential must not be reported as a network fault.
 *
 * The probe here is presence-only, and the reason recorded for that was WRONG: it claimed no
 * free authenticated endpoint existed, so only a billed request could prove a credential.
 * `bedrock:ListInferenceProfiles` is exactly such an endpoint and `listModels()` already calls
 * it on every `/models` request. Measured against the real control plane with a bogus key:
 *
 *   UnrecognizedClientException · HTTP 403 · "The security token included in the request is
 *   invalid."
 *
 * Every enumeration failure used to collapse to `unreachable` with `String(err)` as the
 * remedy — so the participant was told to check their network when the fix was `aws sso login`.
 * wants the specific credential and the action; these tests are that requirement.
 *
 * The error objects below carry the `name` values the AWS SDK actually sets, which is the only
 * field the classifier reads.
 */

const REGION = "us-west-2";
const USABLE = { source: "env:AWS_PROFILE" as const, usable: true };

function awsError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

async function statusFor(err: Error, profile = "claude-code-sso") {
  const adapter = new AnthropicBedrockAdapter({
    env: { AWS_REGION: REGION },
    discovery: USABLE,
    awsProfile: profile,
    listProfiles: async () => {
      throw err;
    },
  });
  const { providers } = await listProviders([adapter]);
  return providers[0];
}

describe("a credential the control plane rejects", () => {
  it("reports credential_expired, not unreachable", async () => {
    const status = await statusFor(
      awsError(
        "UnrecognizedClientException",
        "The security token included in the request is invalid.",
      ),
    );

    expect(status?.available).toBe(false);
    expect(status?.reason).toBe("credential_expired");
  });

  it("names the profile and the command that fixes it", async () => {
    const status = await statusFor(awsError("ExpiredTokenException", "The security token expired"));

    // The two things  asks for. A stringified SDK exception has neither.
    expect(status?.remedy).toContain("claude-code-sso");
    expect(status?.remedy).toContain("aws sso login --profile claude-code-sso");
  });

  it("omits the --profile flag when no profile is in play", async () => {
    const status = await statusFor(awsError("ExpiredTokenException", "expired"), "");

    // A remedy telling someone to run `aws sso login --profile ` is worse than one that does
    // not mention a profile at all.
    expect(status?.remedy).not.toContain("--profile ");
  });

  it("treats a resolver failure as a credential problem too", async () => {
    // `CredentialsProviderError` is what the SDK throws when the named profile cannot be
    // resolved at all — still the credential, not the network.
    const status = await statusFor(
      awsError("CredentialsProviderError", "Profile claude-code-sso could not be found"),
    );

    expect(status?.reason).toBe("credential_expired");
  });
});

describe("a role without the permission", () => {
  it("reports not_entitled and names the missing action", async () => {
    const status = await statusFor(
      awsError("AccessDeniedException", "User is not authorized to perform this operation"),
    );

    // Distinct from an expired credential: logging in again fixes nothing here.
    expect(status?.reason).toBe("not_entitled");
    expect(status?.remedy).toContain("bedrock:ListInferenceProfiles");
  });
});

describe("a failure this code cannot name", () => {
  it("stays unreachable rather than guessing at the credential", async () => {
    const status = await statusFor(awsError("TimeoutError", "socket hang up"));

    // The honest answer. Classifying an unknown fault as a credential problem would send
    // someone to re-authenticate over a network blip.
    expect(status?.reason).toBe("unreachable");
    expect(status?.remedy).toContain("socket hang up");
  });

  it("keeps an empty catalogue unreachable, since it is not an auth failure", async () => {
    const adapter = new AnthropicBedrockAdapter({
      env: { AWS_REGION: REGION },
      discovery: USABLE,
      listProfiles: async () => [],
    });

    const { providers } = await listProviders([adapter]);
    // An account with no Anthropic profiles enabled is a real state, and it is not an expired
    // credential — the credential worked well enough to return a list.
    expect(providers[0]?.reason).toBe("unreachable");
  });
});

/**
 * The same requirement, one adapter family over — and a case the union anticipated with no code
 * path producing it.
 *
 * `classifyProbeFailure` switched on HTTP status alone, so the SDK's own
 * "Could not resolve authentication method" — thrown before a request is sent, hence status-less —
 * fell to `unreachable` and told the developer to check a network that was never used.
 */
describe("an auth-resolution failure is not a network fault", () => {
  const HINTS = {
    expired: "expired hint",
    notEntitled: "entitlement hint",
    unreachable: "Could not reach the Anthropic API. Check network access and try again",
    noCredential: "The SDK found no credential to send. Export ANTHROPIC_API_KEY.",
  };

  it("classifies the SDK's own message as no_credential", () => {
    const err = new Error(
      "Could not resolve authentication method. Expected one of apiKey, authToken, " +
        "credentials, config, or profile to be set.",
    );

    expect(classifyProbeFailure(err, HINTS)).toEqual({
      reason: "no_credential",
      remedy: HINTS.noCredential,
    });
  });

  it("still calls a real transport failure unreachable", () => {
    const err = new Error("getaddrinfo ENOTFOUND api.anthropic.com");

    expect(classifyProbeFailure(err, HINTS).reason).toBe("unreachable");
  });

  it("keeps status-carrying failures on their status, not on message text", () => {
    // A 401 whose body happens to mention authentication is still an expired credential.
    const rejected = Object.assign(new Error("Could not resolve authentication method"), {
      status: 401,
    });

    expect(classifyProbeFailure(rejected, HINTS).reason).toBe("credential_expired");
  });
});

/**
 * A 400 is the CALLER's error, and it was being reported as a network fault.
 *
 * Measured live: a session whose default model was saved as `not-a-real-model` (Settings accepts an
 * unknown model, while it refuses an unknown provider) produced
 *
 *   provider_error kind=api_error
 *     remedy="Could not reach Bedrock. Check network access and the region, then retry the run"
 *     message="Error: 400 The provided model identifier is invalid"
 *
 * Nothing was wrong with the network or the region. `classifyStreamError` branches on 401/403/429 and
 * lets everything else fall to the `unreachable` hint, so a rejected REQUEST is answered with advice
 * about connectivity — the same misclassification a third time, in a third place.
 */
describe("a rejected request is not a network fault", () => {
  const HINTS = {
    expired: "expired hint",
    notEntitled: "entitlement hint",
    unreachable: "Could not reach Bedrock. Check network access and the region",
    noCredential: "no credential hint",
  };

  it("does not blame the network for a 400", () => {
    const err = Object.assign(new Error("400 The provided model identifier is invalid"), {
      status: 400,
    });

    const { remedy } = classifyStreamError(err, HINTS);
    // Not "must never say the word network" — the remedy legitimately says this is NOT a network
    // problem. What it must not do is hand back the connectivity ADVICE.
    expect(remedy).not.toBe(HINTS.unreachable);
    expect(remedy).not.toMatch(/check network access/i);
  });

  it("points at the request, and names the model as the usual cause", () => {
    const err = Object.assign(new Error("400 The provided model identifier is invalid"), {
      status: 400,
    });

    const { remedy } = classifyStreamError(err, HINTS);
    expect(remedy).toMatch(/model/i);
    expect(remedy).toMatch(/rejected|invalid/i);
  });

  it("still calls a genuine transport failure unreachable", () => {
    const { remedy } = classifyStreamError(new Error("getaddrinfo ENOTFOUND"), HINTS);
    expect(remedy).toMatch(/network|region/i);
  });
});

/**
 * A 429 that reports NO limits is not a quota answer, and telling someone to wait is wrong.
 *
 * Measured against the live API with a Keychain subscription credential. The response:
 *
 *   status 429 · x-should-retry: true · request-id present
 *   anthropic-organization-id and anthropic-workspace-id PRESENT — so it authenticated
 *   no `retry-after`, and no `anthropic-ratelimit-*` header of any kind
 *
 * A genuine quota refusal says what the limit is, what remains, and when it resets. This one
 * describes no limit at all, and the vendor's own `message` field is the word "Error". The owner ran
 * `claude setup-token`, followed our remedy — "Wait and retry; reduce concurrent runs if this
 * persists" — and waited, which could not have helped.
 *
 * is the requirement this lands on: whether a third-party client may drive a subscription
 * credential is the account owner's decision, and it can arrive as a 429 rather than a 403. So the
 * remedy must not assert a quota it cannot see — it should say the credential authenticated, that no
 * limit was reported, and what the alternatives are.
 */
describe("a 429 is read by what it reports", () => {
  const HINTS = {
    expired: "expired hint",
    notEntitled: "entitlement hint",
    unreachable: "Could not reach the provider. Check network access",
  };

  const with429 = (headers: Record<string, string>) =>
    Object.assign(new Error("429 rate_limit_error"), {
      status: 429,
      headers: new Headers(headers),
    });

  it("says wait and retry when a real quota IS reported", () => {
    const err = with429({
      "retry-after": "30",
      "anthropic-ratelimit-requests-remaining": "0",
      "anthropic-ratelimit-requests-reset": "2026-08-18T18:00:00Z",
    });

    expect(classifyStreamError(err, HINTS).remedy).toMatch(/wait/i);
  });

  it("does NOT say wait when no limit is reported at all", () => {
    const err = with429({ "x-should-retry": "true", "request-id": "req_x" });

    const { remedy } = classifyStreamError(err, HINTS);
    expect(remedy).not.toMatch(/wait and retry/i);
    // What the reader needs instead: it authenticated, nothing said you are over a limit, and here
    // are the paths that do work.
    expect(remedy).toMatch(/no.*(limit|quota)|reported no/i);
    expect(remedy).toMatch(/API key|Bedrock/i);
  });

  it("treats a partial rate-limit header set as a real quota, erring toward retry", () => {
    // One header is enough to mean "a limit was described"; inventing a threshold would be guessing.
    const err = with429({ "anthropic-ratelimit-tokens-remaining": "0" });

    expect(classifyStreamError(err, HINTS).remedy).toMatch(/wait/i);
  });

  it("still says wait when there are no headers at all to read", () => {
    // A transport that surfaces no headers tells us nothing, so the older, safer advice stands.
    expect(
      classifyStreamError(Object.assign(new Error("429"), { status: 429 }), HINTS).remedy,
    ).toMatch(/wait/i);
  });
});
