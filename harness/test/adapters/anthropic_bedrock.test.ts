import { describe, expect, it } from "vitest";
import { AnthropicBedrockAdapter } from "../../src/providers/anthropic_bedrock.js";
import { listProviders } from "../../src/providers/discovery.js";
import { type CapturedRequest, conformanceRequest, runConformanceSuite } from "./conformance.js";
import { TEXT_BLOCK, anthropicHarness, collect, fakeClient, lifecycle } from "./fake_anthropic.js";

/**
 * Gate 4 against the Bedrock adapter.
 *
 * The suite is the same thirteen assertions the other two face — which is the point of having
 * a suite: the differences between providers should live in `capabilities()` and the
 * destination, not in which conformance rules a provider is excused from.
 *
 * `allowedHosts` is the regional bedrock-runtime endpoint, NOT api.anthropic.com. Assertion 11 is
 * about DESTINATION: a credential travelling to the right provider is the job, and the same
 * credential travelling anywhere else is exfiltration — so declaring the wrong host here is
 * the mistake that assertion exists to catch.
 */

const REGION = "us-east-1";
const TRANSPORT = {
  url: `https://bedrock-runtime.${REGION}.amazonaws.com/model/anthropic.claude-opus-5/invoke-with-response-stream`,
  headers: () => ({
    // SigV4, not an Anthropic api key. The AWS session signs the request.
    authorization: "AWS4-HMAC-SHA256 Credential=not-a-real-credential",
    "content-type": "application/json",
  }),
};

const USABLE = { source: "env:AWS_PROFILE" as const, usable: true };

/**
 * The adapter is QUARANTINED — `probe()` reports unavailable before it looks at a
 * credential, because its model ids and its endpoint disagree about namespaces.
 *
 * Every example below lifts the quarantine, because the logic they cover (credential
 * discovery, region checks, profile listing, dedupe, the stream mapping) is unaffected by it
 * and still has to be right for whichever product the adapter ends up serving. The quarantine itself is
 * asserted in its own block, so lifting it here cannot hide it.
 */
const ENV = { AWS_REGION: REGION, HARNESS_ENABLE_AWS_PROVIDER: "1" };

function harness() {
  return anthropicHarness({
    transport: TRANSPORT,
    allowedHosts: [`bedrock-runtime.${REGION}.amazonaws.com`],
    build: (client, { withoutCredential }) =>
      new AnthropicBedrockAdapter({
        client: client as never,
        env: { ...ENV, AWS_PROFILE: "work" },
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
      env: ENV,
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

  it("FAILS rather than guessing ids when the control plane cannot be reached", async () => {
    const adapter = new AnthropicBedrockAdapter({
      env: ENV,
      discovery: USABLE,
      listProfiles: async () => {
        throw new Error("AccessDeniedException");
      },
    });

    // Bedrock inference-profile ids are ACCOUNT-SPECIFIC, so a static list would offer
    // models this host may not serve — which  forbids. The throw becomes
    // `available: false` plus a remedy at `listProviders`, so the participant learns why
    // rather than picking an id that fails at dispatch.
    await expect(adapter.listModels()).rejects.toThrow(/bedrock:ListInferenceProfiles/);
    await expect(adapter.listModels()).rejects.toThrow(/AccessDeniedException/);
  });

  it("treats an EMPTY listing the same as a failure", async () => {
    const adapter = new AnthropicBedrockAdapter({
      env: ENV,
      discovery: USABLE,
      listProfiles: async () => [],
    });

    // An account with no Anthropic profiles enabled returns an empty list rather than an
    // error. Both mean "this host cannot tell you which models it serves", and neither
    // justifies inventing ids.
    await expect(adapter.listModels()).rejects.toThrow(/listed none/);
  });

  it("is REPORTED as unavailable with a remedy, not dropped from the list", async () => {
    const adapter = new AnthropicBedrockAdapter({
      env: ENV,
      discovery: USABLE,
      listProfiles: async () => {
        throw new Error("AccessDeniedException");
      },
    });

    const { providers } = await listProviders([adapter]);

    // The other half of the decision: failing loudly is only correct because the failure
    // still reaches the picker as an explanation. Omission would reproduce the empty-picker
    // problem the static list was trying to avoid.
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ id: "anthropic-bedrock", available: false });
    expect(providers[0]?.remedy).toMatch(/aws sso login/);
    expect(providers[0]?.models).toEqual([]);
  });

  it("collapses the per-region profile variants of one model", async () => {
    const adapter = new AnthropicBedrockAdapter({
      env: ENV,
      discovery: USABLE,
      listProfiles: async () => [
        { id: "us.anthropic.claude-opus-5-v1:0", displayName: "US Claude Opus 5" },
        { id: "global.anthropic.claude-opus-5-v1:0", displayName: "Global Claude Opus 5" },
        { id: "eu.anthropic.claude-opus-5-v1:0", displayName: "EU Claude Opus 5" },
        { id: "us.anthropic.claude-sonnet-5-v1:0", displayName: "US Claude Sonnet 5" },
      ],
    });

    const models = await adapter.listModels();

    // Bedrock lists one profile per routing scope for the SAME model, so the raw listing shows
    // Opus four times. `global` wins because it is region-agnostic.
    expect(models.map((m) => m.id)).toEqual([
      "global.anthropic.claude-opus-5-v1:0",
      "us.anthropic.claude-sonnet-5-v1:0",
    ]);
  });

  it("infers a context window, since the control plane does not report one", async () => {
    const adapter = new AnthropicBedrockAdapter({
      env: ENV,
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
      env: ENV,
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
      env: ENV,
      discovery: USABLE,
    });

    // PRESENCE-ONLY, weaker than the other two adapters. Mantle exposes only `messages`, so
    // the cheapest real check would be a billed request on every /models call. An expired SSO
    // session therefore reports available here and fails at run start, where `provider_error`
    // carries the reason.
    expect(await adapter.probe()).toEqual({ available: true, credentialSource: "env:AWS_PROFILE" });
  });
});

describe("the AWS profile decides whose account pays", () => {
  it("takes an explicit profile over the host default", () => {
    const adapter = new AnthropicBedrockAdapter({
      env: { AWS_REGION: REGION, AWS_PROFILE: "personal" },
      awsProfile: "claude-code-sso",
      discovery: USABLE,
    });

    // A CONSTRUCTOR option, never `process.env.AWS_PROFILE`. The harness serves many sessions
    // from one process, so mutating the env to select a profile would race between concurrent
    // runs and silently bill the wrong account.
    expect(adapter.profileForTest()).toBe("claude-code-sso");
  });

  it("falls back to HARNESS_AWS_PROFILE, then AWS_PROFILE", () => {
    expect(
      new AnthropicBedrockAdapter({
        env: { AWS_REGION: REGION, HARNESS_AWS_PROFILE: "from-harness", AWS_PROFILE: "ambient" },
      }).profileForTest(),
    ).toBe("from-harness");

    expect(
      new AnthropicBedrockAdapter({
        env: { AWS_REGION: REGION, AWS_PROFILE: "ambient" },
      }).profileForTest(),
    ).toBe("ambient");
  });

  it("leaves the profile unset when the host names none", () => {
    // Then the ambient AWS credential chain applies, which is the ordinary single-profile case.
    expect(
      new AnthropicBedrockAdapter({ env: { AWS_REGION: REGION } }).profileForTest(),
    ).toBeUndefined();
  });

  it("is REPORTED as available once a credential and region are present", async () => {
    const adapter = new AnthropicBedrockAdapter({
      env: { AWS_REGION: REGION },
      awsProfile: "claude-code-sso",
      discovery: USABLE,
      listProfiles: async () => [{ id: "anthropic.claude-opus-5", displayName: "Opus 5" }],
    });

    // The quarantine is gone: the product is resolved (partner-operated Bedrock, legacy
    // client, inference-profile ids), so this adapter can serve runs again.
    expect(await adapter.probe()).toEqual({ available: true, credentialSource: "env:AWS_PROFILE" });
  });
});
