import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { dedupeByModel, inferContextWindow } from "../models.js";
import { type RawStream, mapAnthropicStream } from "./anthropic_family.js";
import type {
  Capabilities,
  EntitlementPosture,
  ModelInfo,
  ProbeResult,
  ProviderAdapter,
  ProviderEvent,
  ProviderRequest,
} from "./contract.js";
import { type Discovery, discoverAwsCredential } from "./credentials/discover.js";

/**
 * Amazon Bedrock, through the host's own AWS session.
 *
 * Uses the **Mantle** client, not the legacy `AnthropicBedrock` bedrock-runtime InvokeModel
 * path, and not the first-party client with a `baseURL` override — R3 is explicit that the
 * platform client is required. Only this file may import `@anthropic-ai/bedrock-sdk`.
 *
 * THE CAPABILITY GAP IS THE POINT (R4). Bedrock has no web search, no web fetch, no code
 * execution, no automatic prompt caching, no Models API, and no server-side refusal
 * fallback. Declaring that here is what lets the loop stay provider-agnostic: it reads
 * `capabilities()` and never special-cases an adapter id. The rejected alternative was a
 * lowest-common-denominator tool set, which would delete web search from first-party
 * sessions to accommodate Bedrock — paying for provider breadth in capability everyone
 * loses.
 */

/**
 * Bedrock capabilities are STATIC, and that is correct rather than degraded.
 *
 * The Models API is first-party only, so there is nothing to query. `models.ts`'s fallback
 * table stopped being a degraded path for this adapter and became the real one — which is
 * why `liveModelDiscovery` is false here even though the model LIST is enumerable from the
 * AWS control plane. The flag is about live CAPABILITY discovery, not about whether ids can
 * be listed.
 */
const BEDROCK_CAPABILITIES: Omit<Capabilities, "contextWindow"> = {
  streaming: true,
  toolUse: true,
  maxOutputTokens: 64_000,
  adaptiveThinking: true,
  thinkingDisplaySummarized: true,
  effortLevels: ["low", "medium", "high", "xhigh", "max"],
  // No AUTOMATIC prompt caching. `minCacheablePrefixTokens: null` rather than a number,
  // so `request_builder` spends no breakpoints it cannot cash.
  promptCaching: false,
  minCacheablePrefixTokens: null,
  serverSideCompaction: false,
  contextEditing: false,
  // The two tools the composer must not offer on a Bedrock session.
  serverSideTools: { webSearch: false, webFetch: false, codeExecution: false },
  liveModelDiscovery: false,
  // FALSE, which is what makes the client-side refusal path necessary rather than optional: on
  // this provider a refusal comes back as a plain stop reason with no fallback content, so
  // the harness has to produce the participant-visible explanation itself.
  serverSideRefusalFallback: false,
  midConversationSystemMessages: true,
  midConversationToolChanges: true,
};

/**
 * NO STATIC MODEL LIST, deliberately.
 *
 * An earlier version of this file kept two `anthropic.`-prefixed ids as a fallback for when
 * the control plane could not be reached, reasoning that an empty picker is worse than a
 * guessed one. That is backwards:  says a participant MUST NOT be offered a model the
 * host cannot serve, and a guessed inference-profile id is exactly that — the account may
 * not have it enabled, and the run fails at dispatch with a provider error instead of at
 * selection with a reason.
 *
 * So discovery FAILS LOUDLY here. `listProviders` catches it and reports this provider
 * `available: false` with the message below as its remedy, which satisfies 's "report
 * why" as well. `web/src/hooks/use_models.ts` already argued the same position for the
 * picker; this makes the harness agree with it.
 */
const DISCOVERY_FAILED =
  "could not list Bedrock inference profiles. The AWS session needs " +
  "bedrock:ListInferenceProfiles, and Bedrock model ids are account-specific so they " +
  "cannot be guessed. Run `aws sso login`, check the region, and confirm the role has " +
  "Bedrock read access";

export interface AnthropicBedrockOptions {
  client?: AnthropicBedrockMantle;
  discovery?: Discovery;
  /** Injected so model discovery is testable without an AWS account. */
  listProfiles?: () => Promise<Array<{ id: string; displayName: string }>>;
  env?: Record<string, string | undefined>;
}

export class AnthropicBedrockAdapter implements ProviderAdapter {
  readonly id = "anthropic-bedrock";
  readonly displayName = "Amazon Bedrock";

  readonly entitlement: EntitlementPosture = {
    credentialKind: "cloud_marketplace",
    // The customer's own AWS account under their own agreement, so no third party is
    // borrowing anyone's seat.
    thirdPartyClientPermitted: "yes",
    note:
      "The host's AWS session. Bedrock-via-SSO expires and the harness cannot refresh it — " +
      "the developer keeps `aws sso login` current.",
  };

  private readonly injectedClient?: AnthropicBedrockMantle;
  private readonly injectedDiscovery?: Discovery;
  private readonly injectedListProfiles?: AnthropicBedrockOptions["listProfiles"];
  private readonly env: Record<string, string | undefined>;
  private capabilityCache = new Map<string, Capabilities>();

  constructor(opts: AnthropicBedrockOptions = {}) {
    this.injectedClient = opts.client;
    this.injectedDiscovery = opts.discovery;
    this.injectedListProfiles = opts.listProfiles;
    this.env = opts.env ?? process.env;
  }

  /**
   * PRESENCE-ONLY, and weaker than the other adapters on purpose — stated so nobody
   * mistakes it for equivalent evidence.
   *
   * The Mantle client exposes only `messages`, so there is no free authenticated endpoint
   * to prove a credential with; the cheapest real check would be a billed request, on
   * every `/models` call. So a live-but-expired SSO session reports available here and
   * fails at run start instead, where `provider_error` carries the real reason. The
   * remedy below names SSO expiry up front for exactly that case.
   */
  async probe(): Promise<ProbeResult> {
    const discovery = this.discover();
    if (!discovery.usable) {
      return {
        available: false,
        reason: discovery.source === "none" ? "no_credential" : "credential_expired",
        remedy: discovery.remedy ?? discovery.problem ?? "unusable AWS credential",
      };
    }
    if (!this.region()) {
      return {
        available: false,
        reason: "no_credential",
        remedy:
          "An AWS credential is present but no region is set. Export AWS_REGION (or " +
          "AWS_DEFAULT_REGION) — Bedrock's endpoint is region-specific, so there is no default.",
      };
    }
    return { available: true, credentialSource: discovery.source };
  }

  /**
   * Live model discovery from the AWS control plane. THROWS when it cannot enumerate.
   *
   * The throw is the feature: `listProviders` turns it into `available: false` plus a
   * remedy, so the participant sees why Bedrock is not offering models instead of seeing
   * two ids that may not resolve on this account.
   */
  async listModels(): Promise<ModelInfo[]> {
    const profiles = await this.profiles();
    return profiles.map((profile) => {
      const capabilities: Capabilities = {
        ...BEDROCK_CAPABILITIES,
        // The control plane's ListInferenceProfiles carries no context window, so it is
        // inferred from the model family — the one place this adapter has to.
        contextWindow: inferContextWindow(profile.id),
      };
      this.capabilityCache.set(profile.id, capabilities);
      return { id: profile.id, displayName: profile.displayName, capabilities };
    });
  }

  capabilities(model: string): Capabilities {
    return (
      this.capabilityCache.get(model) ?? {
        ...BEDROCK_CAPABILITIES,
        contextWindow: inferContextWindow(model),
      }
    );
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const stream = this.client().messages.stream(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: req.messages as never,
        tools: req.tools as never,
        ...(req.thinking ? { thinking: req.thinking as never } : {}),
        ...(req.effort ? { output_config: { effort: req.effort } as never } : {}),
      },
      { signal: req.signal },
    );
    yield* mapAnthropicStream(stream as unknown as RawStream);
  }

  private discover(): Discovery {
    return this.injectedDiscovery ?? discoverAwsCredential({ env: this.env });
  }

  private region(): string | undefined {
    return this.env.AWS_REGION ?? this.env.AWS_DEFAULT_REGION;
  }

  /**
   * Constructed from the DISCOVERED source. `awsProfile` is passed EXPLICITLY when that is
   * what won, rather than letting the default credential chain resolve silently — the run
   * records which source it used, and a client that picked a different one would make that
   * record false.
   */
  private client(): AnthropicBedrockMantle {
    if (this.injectedClient) return this.injectedClient;
    const discovery = this.discover();
    const awsRegion = this.region();

    return discovery.source === "env:AWS_PROFILE"
      ? new AnthropicBedrockMantle({ awsRegion, awsProfile: this.env.AWS_PROFILE })
      : new AnthropicBedrockMantle({ awsRegion });
  }

  /**
   * The seam replaces only the SOURCE, so the surrounding handling runs identically for a
   * real control plane and an injected one.
   *
   * It was originally an early return — `if (injected) return injected()` — which put the
   * seam OUTSIDE that handling and made both failure paths untestable: an injected thrower
   * propagated unchanged, and an injected empty list came straight back. A test seam that
   * bypasses the behaviour under test is worse than none, because the suite then reports on
   * a path production never takes.
   */
  private async profiles(): Promise<Array<{ id: string; displayName: string }>> {
    const source = this.injectedListProfiles ?? (() => listInferenceProfiles(this.region()));
    let found: Array<{ id: string; displayName: string }>;
    try {
      found = await source();
    } catch (err) {
      throw new Error(`${DISCOVERY_FAILED} (${String(err)})`);
    }

    // An account with no Anthropic profiles enabled returns an EMPTY list rather than an
    // error, so empty is treated the same as a failure: both mean "this host cannot tell you
    // which models it serves", and neither justifies inventing ids.
    if (found.length === 0) throw new Error(`${DISCOVERY_FAILED} (the account listed none)`);

    // DEDUPED HERE, not inside `listInferenceProfiles`, so an injected source is deduped too —
    // the same seam lesson as above. Bedrock exposes a separate cross-region inference profile
    // per routing scope (us./global./eu./apac.) for the SAME model, so the raw listing yields
    // "US Claude Opus 5" next to "Global Claude Opus 5". Without this the picker shows one
    // model four times and a participant has to guess which routing scope they want.
    return dedupeByModel(
      found.map((p) => ({ id: p.id, label: p.displayName, context_window: 0 })),
    ).map((p) => ({ id: p.id, displayName: p.label }));
  }
}

/**
 * Anthropic system-defined inference profiles available to this AWS session.
 *
 * Dynamically imported so a host with no Bedrock never pays to load the AWS SDK. Uses the
 * Bedrock CONTROL-plane client, which is a different service from bedrock-runtime and a
 * different one again from Mantle — three names for what a reader might assume is one API.
 */
async function listInferenceProfiles(
  region: string | undefined,
): Promise<Array<{ id: string; displayName: string }>> {
  const { BedrockClient, ListInferenceProfilesCommand } = await import("@aws-sdk/client-bedrock");
  const client = new BedrockClient({ region });
  const out: Array<{ id: string; displayName: string }> = [];
  let nextToken: string | undefined;

  do {
    const res = await client.send(
      new ListInferenceProfilesCommand({ typeEquals: "SYSTEM_DEFINED", nextToken }),
    );
    for (const profile of res.inferenceProfileSummaries ?? []) {
      const id = profile.inferenceProfileId;
      // This app drives Claude only; a Bedrock account carries other vendors' profiles too.
      if (!id || !id.toLowerCase().includes("anthropic")) continue;
      out.push({ id, displayName: profile.inferenceProfileName ?? id });
    }
    nextToken = res.nextToken;
  } while (nextToken);

  return out;
}
