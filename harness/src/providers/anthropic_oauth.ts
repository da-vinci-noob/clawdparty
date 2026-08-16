import { platform } from "node:os";
import Anthropic from "@anthropic-ai/sdk";
import { type RawStream, classifyProbeFailure, mapAnthropicStream } from "./anthropic_family.js";
import { toAnthropicMessages } from "./anthropic_request.js";
import type {
  Capabilities,
  EntitlementPosture,
  ModelInfo,
  ProbeResult,
  ProviderAdapter,
  ProviderEvent,
  ProviderRequest,
} from "./contract.js";
import { type Discovery, discoverAnthropicCredential } from "./credentials/discover.js";
import { KEYCHAIN_SOURCE } from "./credentials/sources.js";

/**
 * The host developer's Claude subscription or enterprise SSO login.
 *
 * A SEPARATE adapter from `anthropic-direct` even though both talk to the same API and
 * `anthropic_direct` can already consume an OAuth token in one of its credential slots.
 * The reason is not the transport, it is the ENTITLEMENT: a subscription token is a
 * person's seat, and whether a third-party client may drive it is the account owner's
 * decision rather than something this codebase can answer. Folding it into the
 * API-key adapter would attach `thirdPartyClientPermitted: "yes"` to a credential where
 * that is not established, and the posture is recorded per adapter precisely so the answer
 * is visible instead of assumed.
 *
 * It is also what a participant is choosing between: "my API key" and "my subscription"
 * bill differently, and a picker that hid the difference would spend the wrong budget.
 *
 * ONLY this file and `anthropic_direct.ts` may import `@anthropic-ai/sdk`.
 */

/**
 * OAuth is a TRANSPORT difference, not a key swap: the token goes in
 * `Authorization: Bearer` with the oauth beta header, NEVER in `x-api-key`. Sending it as
 * an api key is rejected, and the failure looks like an invalid credential rather than a
 * misused one.
 */
const OAUTH_BETA_HEADER = { "anthropic-beta": "oauth-2025-04-20" } as const;

const PROBE_HINTS = {
  expired:
    "The subscription token was rejected (401). It has probably expired — run `claude setup-token` again.",
  notEntitled:
    "The login is valid but this workspace is not entitled to the API (403). An account owner has to grant access.",
  unreachable: "Could not reach the Anthropic API. Check network access and try again",
} as const;

const CONSERVATIVE_FALLBACK: Capabilities = {
  streaming: true,
  toolUse: true,
  toolUseWhileStreaming: true,
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  adaptiveThinking: false,
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

/** The sources this adapter will serve. Anything else belongs to `anthropic-direct`. */
const OAUTH_SOURCES = new Set([
  "env:CLAUDE_CODE_OAUTH_TOKEN",
  "file:~/.claude/.credentials.json",
  "profile:active",
  "profile:ANTHROPIC_PROFILE",
  "profile:default",
]);

/**
 * The macOS Keychain is DISCOVERED but not read here.
 *
 * Reading it means spawning `/usr/bin/security`, and `no_shell_input.test.ts` holds that
 * every process-starting file lives under `tools/` — a provider adapter spawning a process
 * would retire that invariant for a path the OAuth work does not ask for (its scope is the
 * credentials file and the `ant` profile dir). So the source is reported with the remedy
 * that already works, rather than half-supported.
 *
 * does name the Keychain, so this is a gap and not a decision to leave it out; a follow-up
 * carries the question of where such a read may live.
 */
const KEYCHAIN_REMEDY =
  "Your Claude login is in the macOS Keychain, which the harness does not read yet. Run " +
  "`claude setup-token` and export CLAUDE_CODE_OAUTH_TOKEN — the harness picks that up " +
  "directly.";

export interface AnthropicOauthOptions {
  client?: Anthropic;
  discovery?: Discovery;
  os?: string;
}

export class AnthropicOauthAdapter implements ProviderAdapter {
  readonly id = "anthropic-oauth";
  readonly displayName = "Anthropic (host login)";

  readonly entitlement: EntitlementPosture = {
    credentialKind: "subscription",
    // NOT "no", and not "yes". The vendor's terms make this the account owner's call, and
    // `owner_decision_required` must stay distinguishable from a refusal  — a
    // developer using their own login on their own machine is the intended case, and
    // flattening it to "no" would remove a path the requirement explicitly asks for.
    thirdPartyClientPermitted: "owner_decision_required",
    note:
      "The host developer's Claude subscription or enterprise SSO seat. Whether a " +
      "third-party client may drive it is the account owner's decision, not this app's.",
  };

  private readonly injectedClient?: Anthropic;
  private readonly injectedDiscovery?: Discovery;
  private readonly os: string;
  private capabilityCache = new Map<string, Capabilities>();

  constructor(opts: AnthropicOauthOptions = {}) {
    this.injectedClient = opts.client;
    this.injectedDiscovery = opts.discovery;
    this.os = opts.os ?? platform();
  }

  async probe(): Promise<ProbeResult> {
    const discovery = this.discover();

    if (!discovery.usable) {
      return {
        available: false,
        reason: discovery.source === "none" ? "no_credential" : "credential_expired",
        remedy: discovery.remedy ?? discovery.problem ?? "unusable credential",
      };
    }
    if (discovery.source === KEYCHAIN_SOURCE.id) {
      return { available: false, reason: "no_credential", remedy: KEYCHAIN_REMEDY };
    }
    if (!OAUTH_SOURCES.has(discovery.source)) {
      // An API key won its slot, so THIS adapter has nothing to serve — `anthropic-direct`
      // does. Reported rather than silently serving the key under a subscription posture,
      // which would record the wrong entitlement for the run.
      return {
        available: false,
        reason: "no_credential",
        remedy: `An API key (${discovery.source}) takes precedence over the host login, so the
subscription path is not in use. Pick Anthropic (direct), or unset the key to use your
subscription.`,
      };
    }

    try {
      await this.client().models.list({ limit: 1 });
      return { available: true, credentialSource: discovery.source };
    } catch (err) {
      return { available: false, ...classifyProbeFailure(err, PROBE_HINTS) };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const page = await this.client().models.list({ limit: 100 });
    return page.data.map((model) => {
      const capabilities = fromModelsApi(model);
      this.capabilityCache.set(model.id, capabilities);
      return { id: model.id, displayName: model.display_name, capabilities };
    });
  }

  capabilities(model: string): Capabilities {
    return this.capabilityCache.get(model) ?? CONSERVATIVE_FALLBACK;
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const stream = this.client().messages.stream(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: toAnthropicMessages(req.messages) as Anthropic.MessageParam[],
        tools: req.tools as Anthropic.ToolUnion[],
        ...(req.thinking ? { thinking: req.thinking } : {}),
        ...(req.effort ? { output_config: { effort: req.effort } } : {}),
      },
      { signal: req.signal },
    );
    yield* mapAnthropicStream(stream as unknown as RawStream);
  }

  private discover(): Discovery {
    return this.injectedDiscovery ?? discoverAnthropicCredential({ os: this.os });
  }

  /** Built from the DISCOVERED source, never zero-arg. */
  private client(): Anthropic {
    if (this.injectedClient) return this.injectedClient;
    const discovery = this.discover();

    if (discovery.source === "env:CLAUDE_CODE_OAUTH_TOKEN") {
      return new Anthropic({
        authToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        defaultHeaders: OAUTH_BETA_HEADER,
      });
    }

    // The credentials file the Claude CLI writes. The SDK reads it itself, so the token
    // never passes through this process — which is strictly better than us parsing it.
    return new Anthropic({ defaultHeaders: OAUTH_BETA_HEADER });
  }
}

const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Same Models API as the direct adapter — it is the same API, reached with a seat. */
function fromModelsApi(model: Anthropic.ModelInfo): Capabilities {
  const caps = model.capabilities;
  const contextManagement = caps?.context_management;

  return {
    streaming: true,
    toolUse: true,
    toolUseWhileStreaming: true,
    contextWindow: model.max_input_tokens ?? CONSERVATIVE_FALLBACK.contextWindow,
    maxOutputTokens: model.max_tokens ?? CONSERVATIVE_FALLBACK.maxOutputTokens,
    adaptiveThinking: caps?.thinking?.types?.adaptive?.supported === true,
    thinkingDisplaySummarized: caps?.thinking?.supported === true,
    effortLevels: caps ? ALL_EFFORTS.filter((l) => caps.effort?.[l]?.supported === true) : [],
    promptCaching: true,
    minCacheablePrefixTokens: 512,
    serverSideCompaction: contextManagement != null,
    contextEditing: contextManagement?.clear_tool_uses_20250919?.supported === true,
    serverSideTools: {
      webSearch: true,
      webFetch: true,
      codeExecution: caps?.code_execution?.supported === true,
    },
    liveModelDiscovery: true,
    serverSideRefusalFallback: true,
    midConversationSystemMessages: true,
    midConversationToolChanges: true,
  };
}
