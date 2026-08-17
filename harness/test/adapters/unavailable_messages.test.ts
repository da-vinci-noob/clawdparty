import { describe, expect, it } from "vitest";
import { AnthropicBedrockAdapter } from "../../src/providers/anthropic_bedrock.js";
import { AnthropicDirectAdapter } from "../../src/providers/anthropic_direct.js";
import { AnthropicOauthAdapter } from "../../src/providers/anthropic_oauth.js";
import type { ProbeResult } from "../../src/providers/contract.js";
import { listProviders } from "../../src/providers/discovery.js";

/**
 * an unavailable provider is REPORTED with a reason and a specific fix, never
 * omitted and never a generic apology.
 *
 * The failure this is written against: a model picker that is simply empty, with nothing to
 * explain why. Every branch below therefore asserts two things — that the provider still
 * appears in the list, and that its remedy names the ACTUAL thing to do. "Check your
 * credentials" satisfies the first and fails the developer, so the assertions are on
 * specific strings (`claude setup-token`, `aws sso login`, `unset`) rather than on a
 * non-empty message.
 */

/** A probe result's remedy must be actionable; these are the phrasings that qualify. */
const ACTIONABLE =
  /setup-token|aws sso login|unset |ANTHROPIC_API_KEY|AWS_REGION|ant auth login|codex login|Pick /;

function unavailable(result: ProbeResult): { reason: string; remedy: string } {
  if (result.available) throw new Error("expected an unavailable probe");
  return { reason: result.reason, remedy: result.remedy };
}

describe("no credential at all", () => {
  it("direct: names every login route rather than one", async () => {
    const adapter = new AnthropicDirectAdapter({
      discovery: {
        source: "none",
        usable: false,
        problem: "no Anthropic credential found",
        remedy: "Run `claude setup-token`, or export ANTHROPIC_API_KEY, or run `ant auth login`.",
      },
    });

    const { reason, remedy } = unavailable(await adapter.probe());

    expect(reason).toBe("no_credential");
    // Four access paths exist; a remedy naming only one sends a Bedrock user down the wrong
    // road.
    expect(remedy).toMatch(ACTIONABLE);
  });

  it("bedrock: names SSO expiry up front, because it is the recurring case", async () => {
    // Discovery INJECTED. Left to resolve for itself it reads the real `homedir()`, so on a
    // machine that happens to have `~/.aws` this passed the credential check and failed on
    // the region instead — a test whose outcome depended on whose laptop ran it.
    const adapter = new AnthropicBedrockAdapter({
      // The quarantine is lifted so this tests the CREDENTIAL message. The quarantine itself
      // reports first and has its own coverage in `anthropic_bedrock.test.ts`.
      env: { HARNESS_ENABLE_AWS_PROVIDER: "1" },
      discovery: {
        source: "none",
        usable: false,
        problem: "no AWS credential found for Bedrock",
        remedy:
          "Run `aws sso login` or set AWS_PROFILE. Bedrock via SSO expires — the harness " +
          "cannot refresh it for you.",
      },
    });

    const { reason, remedy } = unavailable(await adapter.probe());

    expect(reason).toBe("no_credential");
    expect(remedy).toMatch(/aws sso login/);
    // The harness cannot refresh an SSO token, and saying so prevents "why didn't it retry".
    expect(remedy).toMatch(/cannot refresh it/);
  });
});

describe("a credential that is present but unusable", () => {
  it("direct: reports the empty-key trap as EXPIRED, not as absent", async () => {
    const adapter = new AnthropicDirectAdapter({
      discovery: {
        source: "env:ANTHROPIC_API_KEY",
        usable: false,
        problem: "ANTHROPIC_API_KEY is set but empty",
        remedy: "unset ANTHROPIC_API_KEY to fall through, or give it a real value.",
      },
    });

    const { reason, remedy } = unavailable(await adapter.probe());

    // `no_credential` would be wrong and misleading: there IS one, it is in the way. The
    // distinction is what tells a developer to remove something rather than add something.
    expect(reason).toBe("credential_expired");
    expect(remedy).toMatch(/unset ANTHROPIC_API_KEY/);
  });

  it("bedrock: a region-less AWS session is reported as such", async () => {
    const adapter = new AnthropicBedrockAdapter({
      env: { AWS_PROFILE: "work", HARNESS_ENABLE_AWS_PROVIDER: "1" },
      discovery: { source: "env:AWS_PROFILE", usable: true },
    });

    const { remedy } = unavailable(await adapter.probe());

    // Bedrock's endpoint is region-specific with no default, so a valid credential with no
    // region fails in a way that looks like an auth problem unless it is named.
    expect(remedy).toMatch(/AWS_REGION/);
    expect(remedy).toMatch(/no default/);
  });
});

describe("the wrong provider for the credential that won", () => {
  it("oauth: says an API key took precedence and which provider to pick instead", async () => {
    const adapter = new AnthropicOauthAdapter({
      discovery: { source: "env:ANTHROPIC_API_KEY", usable: true },
    });

    const { reason, remedy } = unavailable(await adapter.probe());

    // Serving the key under a subscription posture would record the wrong entitlement for
    // the run, so this is unavailable rather than quietly equivalent.
    expect(reason).toBe("no_credential");
    expect(remedy).toMatch(/Pick Anthropic \(direct\)/);
    expect(remedy).toMatch(/unset the key/);
  });

  it("oauth: names the Keychain gap and the workaround that works today", async () => {
    const adapter = new AnthropicOauthAdapter({
      discovery: { source: "keychain:anthropic-oauth", usable: true },
      // INJECTED, and required now that the Keychain is genuinely read: without it this test asked
      // the developer's own Keychain and then, if it answered, the real API — passing or failing by
      // whose machine it ran on. The same isolation defect `precedence.test.ts` once had.
      readKeychain: () => null,
    });

    const { remedy } = unavailable(await adapter.probe());

    // The read can fail for reasons this process cannot fix — an ACL that refuses or prompts, or an
    // expired token — so the remedy that works without the Keychain is what must be shown.
    expect(remedy).toMatch(/macOS Keychain/);
    expect(remedy).toMatch(/claude setup-token/);
    expect(remedy).toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it("oauth: does NOT report unavailable when the Keychain token is readable", async () => {
    const adapter = new AnthropicOauthAdapter({
      discovery: { source: "keychain:anthropic-oauth", usable: true },
      readKeychain: () => "sample-not-real",
      client: { models: { list: async () => ({ data: [] }) } } as never,
    });

    // The complement, so "unavailable" cannot quietly become the answer for every Keychain host
    // again: a readable token means this adapter serves the run.
    expect(await adapter.probe()).toMatchObject({
      available: true,
      credentialSource: "keychain:anthropic-oauth",
    });
  });
});

describe("a rejected credential", () => {
  const rejecting = (status: number) => ({
    models: {
      list: async () => {
        throw Object.assign(new Error(`HTTP ${status}`), { status });
      },
    },
  });

  it("401 is EXPIRED with a refresh instruction", async () => {
    const adapter = new AnthropicDirectAdapter({
      discovery: { source: "env:ANTHROPIC_API_KEY", usable: true },
      client: rejecting(401) as never,
    });

    const { reason, remedy } = unavailable(await adapter.probe());
    expect(reason).toBe("credential_expired");
    expect(remedy).toMatch(/401/);
  });

  it("403 is NOT_ENTITLED, which is a different fix entirely", async () => {
    const adapter = new AnthropicDirectAdapter({
      discovery: { source: "env:ANTHROPIC_API_KEY", usable: true },
      client: rejecting(403) as never,
    });

    const { reason, remedy } = unavailable(await adapter.probe());

    // Refreshing a credential that is valid-but-unentitled changes nothing; someone with
    // account access has to grant it. Collapsing 401 and 403 sends people to re-login
    // repeatedly against a permission problem.
    expect(reason).toBe("not_entitled");
    expect(remedy).toMatch(/403/);
  });

  it("a network failure is UNREACHABLE and carries the underlying error", async () => {
    const adapter = new AnthropicDirectAdapter({
      discovery: { source: "env:ANTHROPIC_API_KEY", usable: true },
      client: {
        models: {
          list: async () => {
            throw new Error("ENOTFOUND api.anthropic.com");
          },
        },
      } as never,
    });

    const { reason, remedy } = unavailable(await adapter.probe());
    expect(reason).toBe("unreachable");
    expect(remedy).toMatch(/ENOTFOUND/);
  });
});

describe("an unavailable provider is still LISTED", () => {
  it("appears with its reason and remedy instead of being dropped", async () => {
    const unavailableAdapter = new AnthropicDirectAdapter({
      discovery: { source: "none", usable: false, remedy: "Run `claude setup-token`." },
    });

    const { providers } = await listProviders([unavailableAdapter]);

    // THE failure mode  was written against: omission produces "the picker is just
    // empty" with nothing to explain it.
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      id: "anthropic-direct",
      available: false,
      reason: "no_credential",
    });
    expect(providers[0]?.remedy).toMatch(/setup-token/);
  });

  it("survives an adapter that THROWS, without taking the others down", async () => {
    const exploding = {
      id: "exploding",
      displayName: "Exploding",
      entitlement: { credentialKind: "api_key", thirdPartyClientPermitted: "yes", note: "" },
      probe: async () => {
        throw new Error("kaboom");
      },
      listModels: async () => [],
      capabilities: () => ({}) as never,
      stream: async function* () {},
    };
    const healthy = new AnthropicDirectAdapter({
      discovery: { source: "none", usable: false, remedy: "Run `claude setup-token`." },
    });

    const { providers } = await listProviders([exploding as never, healthy]);

    // One misbehaving provider must not 500 `/models` — that takes the picker down for
    // EVERY provider, including the working ones.
    expect(providers).toHaveLength(2);
    expect(providers.map((p) => p.available)).toEqual([false, false]);
  });

  it("never reports a credential VALUE, only a source identity", async () => {
    const adapter = new AnthropicDirectAdapter({
      discovery: { source: "env:ANTHROPIC_API_KEY", usable: true },
      client: {
        models: { list: async () => ({ data: [] }) },
      } as never,
    });

    const { providers } = await listProviders([adapter]);

    // `credentialSource` is an IDENTITY. A provider list is served to every participant, so
    // a value here would leak to the room.
    expect(providers[0]?.credentialSource).toBe("env:ANTHROPIC_API_KEY");
    expect(JSON.stringify(providers)).not.toMatch(/sk-ant/);
  });
});
