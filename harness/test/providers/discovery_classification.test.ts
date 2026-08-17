import { describe, expect, it } from "vitest";
import { AnthropicBedrockAdapter } from "../../src/providers/anthropic_bedrock.js";
import { classifyProbeFailure } from "../../src/providers/anthropic_family.js";
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
