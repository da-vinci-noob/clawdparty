import { describe, expect, it } from "vitest";
import { AnthropicBedrockAdapter } from "../../src/providers/anthropic_bedrock.js";
import { type CapturedRequest, conformanceRequest, runConformanceSuite } from "./conformance.js";
import { TEXT_BLOCK, anthropicHarness, collect, fakeClient, lifecycle } from "./fake_anthropic.js";

/**
 * Gate 4 against the Bedrock adapter.
 *
 * The suite is the same thirteen assertions the other two face — which is the point of having
 * a suite: the differences between providers should live in `capabilities()` and the
 * destination, not in which conformance rules a provider is excused from.
 *
 * `allowedHosts` is the regional Mantle endpoint, NOT api.anthropic.com. Assertion 11 is
 * about DESTINATION: a credential travelling to the right provider is the job, and the same
 * credential travelling anywhere else is exfiltration — so declaring the wrong host here is
 * the mistake that assertion exists to catch.
 */

const REGION = "us-east-1";
const TRANSPORT = {
  url: `https://bedrock-mantle.${REGION}.api.aws/anthropic/v1/messages`,
  headers: () => ({
    // SigV4, not an Anthropic api key. The AWS session signs the request.
    authorization: "AWS4-HMAC-SHA256 Credential=not-a-real-credential",
    "content-type": "application/json",
  }),
};

const USABLE = { source: "env:AWS_PROFILE" as const, usable: true };

function harness() {
  return anthropicHarness({
    transport: TRANSPORT,
    allowedHosts: [`bedrock-mantle.${REGION}.api.aws`],
    build: (client, { withoutCredential }) =>
      new AnthropicBedrockAdapter({
        client: client as never,
        env: { AWS_REGION: REGION, AWS_PROFILE: "work" },
        // Model discovery is injected: the real path calls the AWS control plane, and a
        // conformance run must not depend on an AWS account existing.
        listProfiles: async () => [
          { id: "anthropic.claude-opus-5", displayName: "Claude Opus 5 (Bedrock)" },
        ],
        discovery: withoutCredential
          ? {
              source: "none",
              usable: false,
              problem: "no AWS credential found for Bedrock",
              remedy: "Run `aws sso login` or set AWS_PROFILE.",
            }
          : USABLE,
      }),
  });
}

describe("anthropic-bedrock — adapter conformance (gate 4)", () => {
  runConformanceSuite({
    name: "anthropic-bedrock",
    build: harness,
    // The `anthropic.`-prefixed id form Bedrock's `model` parameter needs (R3). A bare
    // first-party id is rejected there, so using one here would test the wrong thing.
    models: ["anthropic.claude-opus-5"],
  });
});

describe("anthropic-bedrock — model discovery without a Models API", () => {
  it("lists inference profiles from the control plane", async () => {
    const adapter = new AnthropicBedrockAdapter({
      env: { AWS_REGION: REGION },
      discovery: USABLE,
      listProfiles: async () => [
        { id: "anthropic.claude-opus-5", displayName: "Opus 5" },
        { id: "anthropic.claude-sonnet-5", displayName: "Sonnet 5" },
      ],
    });

    const models = await adapter.listModels();

    expect(models.map((m) => m.id)).toEqual([
      "anthropic.claude-opus-5",
      "anthropic.claude-sonnet-5",
    ]);
  });

  it("falls back to a static list rather than emptying the picker", async () => {
    const adapter = new AnthropicBedrockAdapter({
      env: { AWS_REGION: REGION },
      discovery: USABLE,
      listProfiles: async () => {
        throw new Error("AccessDeniedException");
      },
    });

    const models = await adapter.listModels();

    // A listing failure must not produce an empty picker — that is the  failure
    // mode, and a permissions gap on ListInferenceProfiles is common on locked-down accounts.
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.id.startsWith("anthropic."))).toBe(true);
  });

  it("falls back when the control plane returns NOTHING, not just when it throws", async () => {
    const adapter = new AnthropicBedrockAdapter({
      env: { AWS_REGION: REGION },
      discovery: USABLE,
      listProfiles: async () => [],
    });

    // An account with no Anthropic profiles enabled returns an empty list rather than an
    // error, and an empty list reaching the picker is indistinguishable from a broken login.
    expect((await adapter.listModels()).length).toBeGreaterThan(0);
  });

  it("infers a context window, since the control plane does not report one", async () => {
    const adapter = new AnthropicBedrockAdapter({
      env: { AWS_REGION: REGION },
      discovery: USABLE,
      listProfiles: async () => [
        { id: "us.anthropic.claude-sonnet-5-v1:0", displayName: "Sonnet 5" },
        { id: "us.anthropic.claude-haiku-4-5-v1:0", displayName: "Haiku 4.5" },
      ],
    });

    const models = await adapter.listModels();

    // The live context indicator divides by this, so a single wrong constant for every model
    // would misreport pressure on exactly the models where it matters.
    expect(models[0]?.capabilities.contextWindow).toBe(1_000_000);
    expect(models[1]?.capabilities.contextWindow).toBe(200_000);
  });
});

describe("anthropic-bedrock — the request it builds", () => {
  it("sends the model id it was given, unprefixed by this adapter", async () => {
    const captured: CapturedRequest[] = [];
    const adapter = new AnthropicBedrockAdapter({
      env: { AWS_REGION: REGION },
      discovery: USABLE,
      client: fakeClient(
        { events: lifecycle([TEXT_BLOCK], "end_turn"), blocks: [TEXT_BLOCK] },
        captured,
        TRANSPORT,
      ) as never,
    });

    await collect(adapter.stream({ ...conformanceRequest(), model: "anthropic.claude-opus-5" }));

    // The adapter does NOT rewrite ids. Rails/the picker chose a Bedrock id from
    // `listModels()`, and a silent rewrite here would mean the id in the record is not the
    // id that was sent.
    expect(captured[0]?.body.model).toBe("anthropic.claude-opus-5");
  });

  it("reports available without a live authenticated check, and the code says why", async () => {
    const adapter = new AnthropicBedrockAdapter({
      env: { AWS_REGION: REGION },
      discovery: USABLE,
    });

    // PRESENCE-ONLY, weaker than the other two adapters. Mantle exposes only `messages`, so
    // the cheapest real check would be a billed request on every /models call. An expired SSO
    // session therefore reports available here and fails at run start, where `provider_error`
    // carries the reason.
    expect(await adapter.probe()).toEqual({ available: true, credentialSource: "env:AWS_PROFILE" });
  });
});
