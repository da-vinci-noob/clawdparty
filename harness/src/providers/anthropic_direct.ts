import Anthropic from "@anthropic-ai/sdk";
import type { EffortLevel } from "@clawdparty/contracts";
import type {
  Capabilities,
  EntitlementPosture,
  ModelInfo,
  ProbeResult,
  ProviderAdapter,
  ProviderEvent,
  ProviderRequest,
  StopReason,
} from "./contract.js";
import { type Discovery, discoverAnthropicCredential } from "./credentials/discover.js";

/**
 * The reference adapter: first-party Anthropic, full capability set.
 *
 * This is the ONLY file in the harness permitted to import `@anthropic-ai/sdk`.
 * Nothing it returns carries a vendor type across the `ProviderAdapter` seam.
 */

const ALL_EFFORTS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * What the Models API does NOT report, and therefore must be declared.
 *
 * The Models API gives real per-model budgets and flags for effort, thinking,
 * code execution, context management and structured outputs — but says nothing
 * about web search, web fetch, or prompt caching. Those are declared here rather
 * than guessed at the call site, so a provider that lacks them (Bedrock) differs
 * in ONE place instead of being special-cased in the loop (R4).
 */
const DECLARED_FIRST_PARTY = {
  promptCaching: true,
  /**
   * Model-dependent and NOT monotonic across models (512 on Opus 5, 1024 on Opus
   * 4.8, 4096 on Opus 4.6) — never interpolated from a version number.
   */
  minCacheablePrefixTokens: 512,
  serverSideTools: { webSearch: true, webFetch: true, codeExecution: true },
  liveModelDiscovery: true,
  serverSideRefusalFallback: true,
  midConversationSystemMessages: true,
  midConversationToolChanges: true,
} as const;

/** Used only when a model is not in the Models API listing. Deliberately conservative. */
const CONSERVATIVE_FALLBACK: Capabilities = {
  streaming: true,
  toolUse: true,
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

export interface AnthropicDirectOptions {
  /** Injected in tests. Production passes nothing and discovery decides. */
  client?: Anthropic;
  discovery?: Discovery;
}

export class AnthropicDirectAdapter implements ProviderAdapter {
  readonly id = "anthropic-direct";
  readonly displayName = "Anthropic (direct)";

  readonly entitlement: EntitlementPosture = {
    credentialKind: "api_key",
    thirdPartyClientPermitted: "yes",
    note: "First-party API key or auth token. Standard API terms apply.",
  };

  private readonly injectedClient?: Anthropic;
  private readonly injectedDiscovery?: Discovery;
  private capabilityCache = new Map<string, Capabilities>();

  constructor(opts: AnthropicDirectOptions = {}) {
    this.injectedClient = opts.client;
    this.injectedDiscovery = opts.discovery;
  }

  async probe(): Promise<ProbeResult> {
    const discovery = this.discover();
    if (!discovery.usable) {
      return {
        available: false,
        reason: discovery.source === "none" ? "no_credential" : "credential_expired",
        // Required and actionable: a broken credential must name itself AND the fix.
        remedy: discovery.remedy ?? `${discovery.problem ?? "unusable credential"}`,
      };
    }

    try {
      // A cheap authenticated call. Reaching the Models API proves the credential
      // is accepted, which `existsSync` on a file cannot.
      await this.client().models.list({ limit: 1 });
      return { available: true, credentialSource: discovery.source };
    } catch (err) {
      return { available: false, ...classifyProbeFailure(err) };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const page = await this.client().models.list({ limit: 100 });
    const models: ModelInfo[] = [];

    for (const model of page.data) {
      const capabilities = fromModelsApi(model);
      this.capabilityCache.set(model.id, capabilities);
      models.push({ id: model.id, displayName: model.display_name, capabilities });
    }
    return models;
  }

  /**
   * Synchronous by contract, so it serves the cache `listModels()` filled. An
   * unlisted model gets the conservative fallback rather than an optimistic
   * guess: over-declaring sends requests that 400, and the failure surfaces as a
   * provider error rather than as "this model does not support X".
   */
  capabilities(model: string): Capabilities {
    return this.capabilityCache.get(model) ?? CONSERVATIVE_FALLBACK;
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const stream = this.client().messages.stream(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        // Verbatim blocks cross back out exactly as they came in (R6).
        messages: req.messages as Anthropic.MessageParam[],
        tools: req.tools as Anthropic.ToolUnion[],
        ...(req.thinking ? { thinking: req.thinking } : {}),
        ...(req.effort ? { output_config: { effort: req.effort } } : {}),
      },
      { signal: req.signal },
    );

    for await (const event of stream) {
      switch (event.type) {
        case "message_start":
          yield { t: "message_start", model: event.message.model };
          break;

        case "content_block_start":
          yield { t: "block_start", index: event.index, kind: blockKind(event.content_block.type) };
          break;

        case "content_block_delta": {
          const mapped = mapDelta(event.index, event.delta);
          if (mapped) yield mapped;
          break;
        }

        case "content_block_stop": {
          // The SDK accumulates; we pass the block through UNTOUCHED. Rebuilding
          // it here would drop the compaction/thinking state the next request
          // needs and would fail the conformance suite.
          const block = stream.currentMessage?.content[event.index];
          yield { t: "block_stop", index: event.index, block };
          break;
        }

        case "message_delta":
          yield {
            t: "message_delta",
            stopReason: mapStopReason(event.delta.stop_reason),
            usage: {
              input_tokens: event.usage.input_tokens ?? 0,
              output_tokens: event.usage.output_tokens,
              cache_read_input_tokens: event.usage.cache_read_input_tokens ?? 0,
              cache_creation_input_tokens: event.usage.cache_creation_input_tokens ?? 0,
            },
          };
          break;

        case "message_stop":
          yield { t: "message_stop" };
          break;

        default:
          // Never crash on an unmapped shape.
          yield { t: "raw", value: event };
      }
    }
  }

  private discover(): Discovery {
    return this.injectedDiscovery ?? discoverAnthropicCredential();
  }

  /**
   * Constructed from the DISCOVERED slot rather than zero-arg, so the credential
   * the run recorded is the credential the request used. A zero-arg
   * client would resolve silently and could pick a different one.
   */
  private client(): Anthropic {
    if (this.injectedClient) return this.injectedClient;

    const discovery = this.discover();
    switch (discovery.source) {
      case "env:ANTHROPIC_API_KEY":
        return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      case "env:ANTHROPIC_AUTH_TOKEN":
        return new Anthropic({ authToken: process.env.ANTHROPIC_AUTH_TOKEN });
      case "env:CLAUDE_CODE_OAUTH_TOKEN":
        // OAuth is a TRANSPORT difference, not a key swap: Authorization: Bearer
        // plus the oauth beta header, never x-api-key.
        return new Anthropic({
          authToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
          defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
        });
      default:
        // Profile / WIF / credentials-file paths the SDK resolves itself. The
        // source is still recorded, so the choice remains explicit in the record.
        return new Anthropic();
    }
  }
}

function blockKind(type: string): "text" | "thinking" | "tool_use" | "compaction" {
  if (type === "text") return "text";
  if (type === "thinking" || type === "redacted_thinking") return "thinking";
  if (type.startsWith("compaction")) return "compaction";
  return "tool_use";
}

function mapDelta(index: number, delta: Anthropic.RawContentBlockDelta): ProviderEvent | null {
  switch (delta.type) {
    case "text_delta":
      return { t: "text_delta", index, text: delta.text };
    case "thinking_delta":
      return { t: "thinking_delta", index, text: delta.thinking };
    case "input_json_delta":
      return { t: "tool_input_delta", index, partialJson: delta.partial_json };
    default:
      // signature_delta and citations_delta carry no harness-visible text; they
      // ride along inside the verbatim block delivered at block_stop.
      return null;
  }
}

/**
 * `stop_sequence` is the one SDK reason with no harness equivalent — it is a
 * normal end of turn from the loop's point of view. Everything else maps 1:1.
 */
function mapStopReason(reason: Anthropic.StopReason | null): StopReason {
  if (reason === null || reason === "stop_sequence") return "end_turn";
  return reason;
}

function fromModelsApi(model: Anthropic.ModelInfo): Capabilities {
  const caps = model.capabilities;
  const effortLevels = caps
    ? ALL_EFFORTS.filter((level) => caps.effort?.[level]?.supported === true)
    : [];
  const contextManagement = caps?.context_management;

  return {
    streaming: true,
    toolUse: true,
    // Real budgets, straight from the API. The live context indicator divides by
    // this, so a hardcoded constant here would misreport pressure per model.
    contextWindow: model.max_input_tokens ?? CONSERVATIVE_FALLBACK.contextWindow,
    maxOutputTokens: model.max_tokens ?? CONSERVATIVE_FALLBACK.maxOutputTokens,
    adaptiveThinking: caps?.thinking?.types?.adaptive?.supported === true,
    thinkingDisplaySummarized: caps?.thinking?.supported === true,
    effortLevels,
    promptCaching: DECLARED_FIRST_PARTY.promptCaching,
    minCacheablePrefixTokens: DECLARED_FIRST_PARTY.minCacheablePrefixTokens,
    serverSideCompaction: contextManagement != null,
    contextEditing: contextManagement?.clear_tool_uses_20250919?.supported === true,
    serverSideTools: {
      webSearch: DECLARED_FIRST_PARTY.serverSideTools.webSearch,
      webFetch: DECLARED_FIRST_PARTY.serverSideTools.webFetch,
      codeExecution: caps?.code_execution?.supported === true,
    },
    liveModelDiscovery: DECLARED_FIRST_PARTY.liveModelDiscovery,
    serverSideRefusalFallback: DECLARED_FIRST_PARTY.serverSideRefusalFallback,
    midConversationSystemMessages: DECLARED_FIRST_PARTY.midConversationSystemMessages,
    midConversationToolChanges: DECLARED_FIRST_PARTY.midConversationToolChanges,
  };
}

function classifyProbeFailure(err: unknown): {
  reason: "no_credential" | "credential_expired" | "not_entitled" | "unreachable";
  remedy: string;
} {
  const status = (err as { status?: number } | null)?.status;
  if (status === 401) {
    return {
      reason: "credential_expired",
      remedy:
        "The Anthropic credential was rejected (401). Re-run `claude setup-token` or refresh the key.",
    };
  }
  if (status === 403) {
    return {
      reason: "not_entitled",
      remedy:
        "The credential is valid but not entitled to this API (403). Check the workspace's model access.",
    };
  }
  return {
    reason: "unreachable",
    remedy: `Could not reach the Anthropic API: ${String(err)}. Check network access and try again.`,
  };
}
