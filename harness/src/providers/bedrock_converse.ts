import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-provider-ini";
import { inferContextWindow } from "../models.js";
import { isAnthropicProfileId } from "./bedrock_routing.js";
import type {
  Capabilities,
  EntitlementPosture,
  ModelInfo,
  ProbeResult,
  ProviderAdapter,
  ProviderEvent,
  ProviderRequest,
} from "./contract.js";
import {
  converseCapabilities,
  isInvocable,
  toolUseWhileStreaming,
} from "./converse_capabilities.js";
import { toConverseInput } from "./converse_request.js";
import { mapConverseStream } from "./converse_stream.js";
import { type Discovery, discoverAwsCredential } from "./credentials/discover.js";

/**
 * The NON-Anthropic Bedrock models, over the model-agnostic Converse API.
 *
 * A sibling of `anthropic_bedrock.ts`, not a replacement: the Anthropic profiles stay on that
 * adapter, whose `AnthropicBedrock` client speaks the Messages protocol at `/model/{id}/invoke`
 * and gives full Anthropic fidelity. This one serves everything else — OpenAI, Nova, Llama,
 * Mistral, Writer — through `ConverseStream`, whose event vocabulary is different enough that
 * it needs its own mapper (`converse_stream.ts`) and its own request translation
 * (`converse_request.ts`). Both were written against captured bytes, because the
 * protocol was mis-described from documentation twice.
 *
 * Only `anthropic_bedrock.ts` and this file import an AWS runtime SDK.
 *
 * What it deliberately does NOT do yet: run a streaming-limited model (every Llama, Mistral
 * Pixtral, both Writer Palmyra) WITH tools. The loop refuses that combination,
 * because `ConverseStream` rejects a `toolConfig` for those models. The non-streaming
 * `Converse` fallback that would make them fully tool-capable is deferred; until it lands they
 * are usable for chat-style turns and appear labelled in the picker.
 */

/**
 * Not discoverable from Bedrock, so it is a constant rather than a per-model lookup.
 *
 * Deliberately MODEST. `ListFoundationModels` reports no output-token limit, and Bedrock
 * rejects a `maxTokens` above the model's real ceiling with a `ValidationException` that kills
 * the run — so erring high fails, while erring low only truncates. 8192 is accepted by every
 * model measured so far; raising it per-model is a follow-up once the ceilings are known.
 */
const MAX_OUTPUT_TOKENS = 8192;

/** A single ConverseStream call, as an async iterable of raw events. Injected in tests so the
 *  adapter's translation and mapping run without an AWS account. */
export type ConverseRunner = (input: unknown) => AsyncIterable<ConverseStreamOutput>;

/** The candidate profiles this host can serve, before capability gating. Injected in tests. */
export type ListConverseProfiles = () => Promise<Array<{ id: string; displayName: string }>>;

export interface BedrockConverseOptions {
  runner?: ConverseRunner;
  listProfiles?: ListConverseProfiles;
  discovery?: Discovery;
  env?: Record<string, string | undefined>;
  awsProfile?: string;
}

export class BedrockConverseAdapter implements ProviderAdapter {
  readonly id = "bedrock-converse";
  readonly displayName = "Amazon Bedrock (Converse)";

  readonly entitlement: EntitlementPosture = {
    // The host's own AWS account under their own agreement — the same posture as the Anthropic
    // Bedrock adapter, for the same reason: no third party borrows anyone's seat.
    credentialKind: "cloud_marketplace",
    thirdPartyClientPermitted: "yes",
    note:
      "The host's AWS session, via Converse. Bedrock-via-SSO expires and the harness cannot " +
      "refresh it — the developer keeps `aws sso login` current.",
  };

  private readonly injectedRunner?: ConverseRunner;
  private readonly injectedListProfiles?: ListConverseProfiles;
  private readonly injectedDiscovery?: Discovery;
  private readonly env: Record<string, string | undefined>;
  private readonly awsProfile?: string;

  constructor(opts: BedrockConverseOptions = {}) {
    this.injectedRunner = opts.runner;
    this.injectedListProfiles = opts.listProfiles;
    this.injectedDiscovery = opts.discovery;
    this.env = opts.env ?? process.env;
    this.awsProfile = opts.awsProfile ?? this.env.HARNESS_AWS_PROFILE ?? this.env.AWS_PROFILE;
  }

  /**
   * Same presence-only posture as `anthropic_bedrock.ts`: a valid credential and a region.
   * A live-but-expired SSO session reports available here and fails at run start, where
   * `provider_error` carries the real reason — the cheapest true check would be a billed
   * request on every `/models` call.
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
          "AWS_DEFAULT_REGION) — Bedrock's endpoint is region-specific.",
      };
    }
    return { available: true, credentialSource: discovery.source };
  }

  /**
   * The offerable non-Anthropic models: enumerate, then GATE by capability.
   *
   * `isInvocable` drops the models this host cannot serve for reasons that are not
   * capabilities — an entitlement the account lacks (nova-premier: access denied) or a model
   * Converse does not serve (twelvelabs pegasus) or one with no tool support at all (deepseek).
   * Offering any of them would violate , and modality filtering alone does not catch
   * them (pegasus outputs TEXT). The remaining models carry their measured capabilities,
   * including `toolUseWhileStreaming`, so the picker and the loop both see the truth.
   */
  async listModels(): Promise<ModelInfo[]> {
    const profiles = await this.profiles();
    return profiles
      .filter((profile) => isInvocable(profile.id))
      .map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        capabilities: this.capabilities(profile.id),
      }));
  }

  capabilities(model: string): Capabilities {
    return converseCapabilities(model, inferContextWindow(model), MAX_OUTPUT_TOKENS);
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const input = toConverseInput(req);
    yield* mapConverseStream(this.run(input, req.signal), req.model);
  }

  private run(input: unknown, signal: AbortSignal): AsyncIterable<ConverseStreamOutput> {
    if (this.injectedRunner) return this.injectedRunner(input);
    return this.liveRun(input, signal);
  }

  private async *liveRun(input: unknown, signal: AbortSignal): AsyncIterable<ConverseStreamOutput> {
    const { BedrockRuntimeClient, ConverseStreamCommand } = await import(
      "@aws-sdk/client-bedrock-runtime"
    );
    const client = new BedrockRuntimeClient({
      region: this.region(),
      // The SAME named profile the run recorded. Letting the ambient chain
      // resolve would risk billing a different account than the one the record names.
      ...(this.awsProfile ? { credentials: fromIni({ profile: this.awsProfile }) } : {}),
    });
    const res = await client.send(new ConverseStreamCommand(input as never), {
      abortSignal: signal,
    });
    for await (const event of res.stream ?? []) {
      yield event;
    }
  }

  /** Exposed for the same reason as the Anthropic adapter: assert the RESOLVED profile without
   *  reaching into a constructed vendor client. */
  profileForTest(): string | undefined {
    return this.awsProfile;
  }

  private discover(): Discovery {
    return this.injectedDiscovery ?? discoverAwsCredential({ env: this.env });
  }

  private region(): string | undefined {
    return this.env.AWS_REGION ?? this.env.AWS_DEFAULT_REGION;
  }

  private async profiles(): Promise<Array<{ id: string; displayName: string }>> {
    const source =
      this.injectedListProfiles ?? (() => listConverseProfiles(this.region(), this.awsProfile));
    const found = await source();
    // One profile per model: Bedrock lists a separate cross-region profile per routing scope
    // (us./global./…) for the same model, so without this the picker shows each model several
    // times. Keyed on the bare model id — `dedupeByModel` keys on `anthropic.` and would not
    // group `us.openai.…` with `global.openai.…`.
    const seen = new Set<string>();
    return found.filter((profile) => {
      const bare = profile.id.split(".").slice(1).join(".");
      if (seen.has(bare)) return false;
      seen.add(bare);
      return true;
    });
  }
}

/** The non-Anthropic streaming-capable text profiles for this AWS session. The three gates
 *  beyond this (Converse-servable, entitled, tool-capable) live in `isInvocable`/the matrix,
 *  applied in `listModels`. */
async function listConverseProfiles(
  region: string | undefined,
  profile: string | undefined,
): Promise<Array<{ id: string; displayName: string }>> {
  const { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } = await import(
    "@aws-sdk/client-bedrock"
  );
  const client = new BedrockClient({
    region,
    ...(profile ? { credentials: fromIni({ profile }) } : {}),
  });

  // Text-out + streaming, from the foundation-model catalogue. Joined to the profile list by
  // the bare model id, because a profile id prefixes a routing scope.
  const textStreaming = new Set<string>();
  const models = await client.send(new ListFoundationModelsCommand({}));
  for (const m of models.modelSummaries ?? []) {
    if ((m.outputModalities ?? []).includes("TEXT") && m.responseStreamingSupported && m.modelId) {
      textStreaming.add(m.modelId);
    }
  }

  const out: Array<{ id: string; displayName: string }> = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(
      new ListInferenceProfilesCommand({ typeEquals: "SYSTEM_DEFINED", nextToken }),
    );
    for (const p of res.inferenceProfileSummaries ?? []) {
      const id = p.inferenceProfileId;
      // Anthropic profiles belong to the sibling adapter. The SAME predicate that
      // adapter includes on, used with opposite sense here — that is what makes the two
      // filters complementary and double-listing impossible.
      if (!id || isAnthropicProfileId(id)) continue;
      const bare = id.split(".").slice(1).join(".");
      if (textStreaming.has(bare)) {
        out.push({ id, displayName: p.inferenceProfileName ?? id });
      }
    }
    nextToken = res.nextToken;
  } while (nextToken);

  return out;
}

/** Re-exported so callers do not reach into `converse_capabilities` for the one predicate the
 *  picker also needs. */
export { toolUseWhileStreaming };
