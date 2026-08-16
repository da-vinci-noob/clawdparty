import { describe, expect, it } from "vitest";
import { AnthropicOauthAdapter } from "../../src/providers/anthropic_oauth.js";
import { runConformanceSuite } from "./conformance.js";
import { conformanceRequest } from "./conformance.js";
import type { CapturedRequest } from "./conformance.js";
import { anthropicHarness, collect, fakeClient, lifecycle } from "./fake_anthropic.js";
import { TEXT_BLOCK } from "./fake_anthropic.js";

/**
 * Gate 4 against the host-login adapter, plus the two things that make it a SEPARATE adapter
 * rather than a credential slot on `anthropic-direct`: the entitlement posture it records,
 * and its refusal to serve when an API key won the precedence race.
 */

const TRANSPORT = {
  url: "https://api.anthropic.com/v1/messages",
  headers: () => ({
    // OAuth is a TRANSPORT difference: Bearer plus the oauth beta header, never x-api-key.
    authorization: "Bearer not-a-real-token",
    "anthropic-beta": "oauth-2025-04-20",
    "content-type": "application/json",
  }),
};

function harness() {
  return anthropicHarness({
    transport: TRANSPORT,
    allowedHosts: ["api.anthropic.com"],
    build: (client, { withoutCredential }) =>
      new AnthropicOauthAdapter({
        client: client as never,
        discovery: withoutCredential
          ? {
              source: "none",
              usable: false,
              problem: "no Anthropic credential found",
              remedy: "Run `claude setup-token`, or export CLAUDE_CODE_OAUTH_TOKEN.",
            }
          : { source: "env:CLAUDE_CODE_OAUTH_TOKEN", usable: true },
      }),
  });
}

describe("anthropic-oauth — adapter conformance (gate 4)", () => {
  runConformanceSuite({
    name: "anthropic-oauth",
    build: harness,
    models: ["claude-opus-5"],
  });
});

describe("anthropic-oauth — what makes it its own adapter", () => {
  it("records the entitlement as the OWNER'S decision, not as permitted or refused", () => {
    const adapter = new AnthropicOauthAdapter();

    // requires `owner_decision_required` to stay distinguishable from "no". Reporting
    // "yes" would assert something this codebase cannot establish; reporting "no" would
    // remove an access path the requirement explicitly asks for.
    expect(adapter.entitlement.credentialKind).toBe("subscription");
    expect(adapter.entitlement.thirdPartyClientPermitted).toBe("owner_decision_required");
  });

  it("differs from anthropic-direct's posture, which is the whole reason both exist", async () => {
    const { AnthropicDirectAdapter } = await import("../../src/providers/anthropic_direct.js");

    expect(new AnthropicDirectAdapter().entitlement.thirdPartyClientPermitted).toBe("yes");
    expect(new AnthropicOauthAdapter().entitlement.thirdPartyClientPermitted).not.toBe("yes");
  });

  it("serves the profile sources too, not only the env token", async () => {
    const captured: CapturedRequest[] = [];
    const adapter = new AnthropicOauthAdapter({
      client: fakeClient(
        { events: lifecycle([TEXT_BLOCK], "end_turn"), blocks: [TEXT_BLOCK] },
        captured,
        TRANSPORT,
      ) as never,
      discovery: { source: "profile:active", usable: true },
    });

    const probe = await adapter.probe();

    // `ant auth login` writes a profile, and the credential scope names the profile dir alongside
    // the credentials file — an adapter that only accepted the env token would leave the
    // documented login path unserved.
    expect(probe.available).toBe(true);
  });

  it("sends the oauth beta header, since a bare Bearer is rejected", async () => {
    const captured: CapturedRequest[] = [];
    const adapter = new AnthropicOauthAdapter({
      client: fakeClient(
        { events: lifecycle([TEXT_BLOCK], "end_turn"), blocks: [TEXT_BLOCK] },
        captured,
        TRANSPORT,
      ) as never,
      discovery: { source: "env:CLAUDE_CODE_OAUTH_TOKEN", usable: true },
    });

    await collect(adapter.stream(conformanceRequest()));

    expect(captured[0]?.headers?.["anthropic-beta"]).toBe("oauth-2025-04-20");
    // Never as an api key: sending it that way fails in a way that looks like an invalid
    // credential rather than a misused one, which sends a developer down the wrong path.
    expect(captured[0]?.headers?.["x-api-key"]).toBeUndefined();
  });
});
