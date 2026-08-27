import { platform } from "node:os";
import Anthropic from "@anthropic-ai/sdk";
import { compactionDirective } from "../context/compaction.js";
import {
  DEFAULT_THINKING_BUDGET_TOKENS,
  type RawStream,
  classifyProbeFailure,
  mapAnthropicStream,
} from "./anthropic_family.js";
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
import {
  type Discovery,
  discoverAnthropicCredential,
  readClaudeOauthToken,
} from "./credentials/discover.js";
import { readKeychainToken } from "./credentials/keychain.js";
import { KEYCHAIN_SOURCE } from "./credentials/sources.js";
import { type SystemBlock, withClaudeCodeIdentity } from "./oauth_identity.js";

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
  noCredential:
    "The SDK found no credential to send. Run `claude /login`, or `claude setup-token` and " +
    "export CLAUDE_CODE_OAUTH_TOKEN.",
  // The 429 that is not a limit, with the cause MEASURED rather than guessed: same token, headers
  // and model, only the system block changed — empty gave this 429, the Claude Code identity gave a
  // 200. Named here rather than in the shared classifier because the cause belongs to this
  // credential kind, and the shared text used to blame the account's entitlement, which was wrong.
  quotaUnreported:
    "The provider accepted this credential and then refused the request, reporting no limit and no " +
    "retry time — so this is not your usage running out. A subscription token is issued to Claude " +
    "Code, and this API refuses a request that does not identify as it. clawdparty does not send " +
    "that identity unless you opt in, because doing so asserts a product identity it does not " +
    "have — your account, your call. Set HARNESS_OAUTH_CLAUDE_CODE_IDENTITY=1 in .env.local and " +
    "restart the harness to enable it, or use an API key or Amazon Bedrock, which need no such " +
    "decision.",
} as const;

const CONSERVATIVE_FALLBACK: Capabilities = {
  streaming: true,
  toolUse: true,
  toolUseWhileStreaming: true,
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  adaptiveThinking: false,
  // Conservative: omitting `thinking` works everywhere, so a wrong null costs a feature while a
  // wrong number costs the turn.
  thinkingBudgetTokens: null,
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
  KEYCHAIN_SOURCE.id,
  "profile:active",
  "profile:ANTHROPIC_PROFILE",
  "profile:default",
]);

/**
 * The Keychain is now READ, not merely discovered.
 *
 * Both reasons for withholding it were stale. The invariant cited ("every process-starting file
 * lives under `tools/`") was replaced with "on the allowlist AND argv-form with no
 * interpolated input" — reshaped *specifically* so a Keychain reader is judged on its shape — and
 * `credentials/keychain.ts` is on that allowlist. The other reason was that the SDK resolves the
 * credential itself, which it does not: it reads neither this item nor the credentials file.
 *
 * The remedy below survives as the FALLBACK, for the case the read cannot be verified from here:
 * the item was created by another application, so its ACL may prompt or refuse.
 */
const KEYCHAIN_REMEDY =
  "Your Claude login is in the macOS Keychain but could not be read — the item was created by " +
  "another application, so macOS may be refusing this process or waiting on a confirmation nobody " +
  "can answer, and the stored token may simply have expired. Run `claude setup-token` and export " +
  "CLAUDE_CODE_OAUTH_TOKEN, which the harness reads directly with no Keychain involved.";

export interface AnthropicOauthOptions {
  client?: Anthropic;
  discovery?: Discovery;
  os?: string;
  /** Injected so the credentials-file path is testable against a fake home. */
  home?: string;
  /**
   * Injected so the Keychain path is testable without reading a real one. Returns the RAW stored
   * value, not a token: parsing stays inside `readKeychainToken`, so a test exercises the real thing
   * rather than a second copy of it.
   */
  readKeychain?: () => string | null;
}

export class AnthropicOauthAdapter implements ProviderAdapter {
  readonly id = "anthropic-oauth";
  readonly displayName = "Anthropic (host login)";

  // The SAME strings the probe uses — one set of words per adapter, so the mid-run message
  // and the discovery message cannot drift apart.
  readonly failureHints = PROBE_HINTS;

  readonly entitlement: EntitlementPosture = {
    credentialKind: "subscription",
    // NOT "no", and not "yes". The vendor's terms make this the account owner's call, and
    // `owner_decision_required` must stay distinguishable from a refusal  — a
    // developer using their own login on their own machine is the intended case, and
    // flattening it to "no" would remove a path the requirement explicitly asks for.
    thirdPartyClientPermitted: "owner_decision_required",
    note:
      "The host developer's Claude subscription or enterprise SSO seat. Whether a " +
      "third-party client may drive it is the account owner's decision, not this app's. " +
      "MEASURED 2026-08-20: the seat IS able to drive this API — the request must identify as " +
      "Claude Code, which clawdparty sends only when HARNESS_OAUTH_CLAUDE_CODE_IDENTITY is set. " +
      "That flag is the owner's decision, taken per host, and is off by default.",
  };

  private readonly injectedClient?: Anthropic;
  private readonly injectedDiscovery?: Discovery;
  private readonly os: string;
  private readonly home?: string;
  private readonly rawKeychain?: () => string | null;
  /** Memoised: `undefined` = not asked yet, `null` = asked and unreadable. */
  private keychainCache: string | null | undefined;
  private capabilityCache = new Map<string, Capabilities>();

  constructor(opts: AnthropicOauthOptions = {}) {
    this.injectedClient = opts.client;
    this.injectedDiscovery = opts.discovery;
    this.os = opts.os ?? platform();
    this.home = opts.home;
    this.rawKeychain = opts.readKeychain;
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
    if (discovery.source === KEYCHAIN_SOURCE.id && this.keychainToken() === null) {
      // Discovered but unreadable — a denied or prompting ACL, or an expired token. The developer is
      // exactly where they were, so the remedy that does work is what they should see.
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

  /**
   * The system prompt this adapter actually sends.
   *
   * Public so the opt-in is testable without a live request, and because it is the ONE place the
   * identity is applied — `verify.ts` probes through `stream()`, so the probe and real runs cannot
   * disagree about what was sent. Two seams here is how the panel would report VERIFIED for a
   * credential that then failed a run.
   */
  systemFor(system: readonly SystemBlock[]): SystemBlock[] {
    return withClaudeCodeIdentity(system);
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const stream = this.client().messages.stream(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: this.systemFor(req.system as readonly SystemBlock[]),
        messages: toAnthropicMessages(req.messages) as Anthropic.MessageParam[],
        tools: req.tools as Anthropic.ToolUnion[],
        ...(req.thinking ? { thinking: req.thinking } : {}),
        ...(req.effort ? { output_config: { effort: req.effort } } : {}),
        // Server-side compaction, when BOTH the request asked and this model reported the edit
        // type. `req.compaction` was set here since M4 and read by nobody, so a session
        // past the window looped on `model_context_window_exceeded` forever having never once
        // asked to be compacted.
        ...(compactionDirective(this.capabilities(req.model), req.compaction) ?? {}),
      },
      { signal: req.signal },
    );
    yield* mapAnthropicStream(stream as unknown as RawStream);
  }

  private discover(): Discovery {
    return this.injectedDiscovery ?? discoverAnthropicCredential({ os: this.os, home: this.home });
  }

  /**
   * One Keychain read per adapter, cached.
   *
   * `probe()` and `client()` both need the answer, and a repeated read against an ACL that prompts
   * would ask the developer twice for one run.
   */
  private keychainToken(): string | null {
    if (this.keychainCache === undefined) {
      const raw = this.rawKeychain;
      this.keychainCache = raw ? readKeychainToken(() => raw()) : readKeychainToken();
    }
    return this.keychainCache;
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

    // The credentials file the Claude CLI writes. It was believed the SDK reads it itself, so
    // this constructed a ZERO-ARG client — and the SDK, which reads no such file, threw
    // "Could not resolve authentication method" before sending anything. On a host whose only
    // Claude login lives in that file, both Anthropic paths were dead.
    if (discovery.source === KEYCHAIN_SOURCE.id) {
      const keychainToken = this.keychainToken();
      if (keychainToken) {
        return new Anthropic({ authToken: keychainToken, defaultHeaders: OAUTH_BETA_HEADER });
      }
    }

    const fileToken = readClaudeOauthToken(this.home);
    if (fileToken) {
      return new Anthropic({ authToken: fileToken, defaultHeaders: OAUTH_BETA_HEADER });
    }
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
    // Read from the SAME live capability metadata as `adaptive` above, one sibling over. This host
    // serves neither first-party path (no API key, no OAuth token), so unlike the Bedrock table this
    // is NOT measured here — it mirrors the adjacent field's shape, and a null costs only a feature.
    thinkingBudgetTokens:
      caps?.thinking?.types?.enabled?.supported === true ? DEFAULT_THINKING_BUDGET_TOKENS : null,
    thinkingDisplaySummarized: caps?.thinking?.supported === true,
    effortLevels: caps ? ALL_EFFORTS.filter((l) => caps.effort?.[l]?.supported === true) : [],
    promptCaching: true,
    minCacheablePrefixTokens: 512,
    // The SPECIFIC edit type, not merely "context management exists". `context_management` is a
    // non-optional field on the SDK's capability object, so `!= null` was true for every model
    // with capabilities at all — it reported compaction support universally, and once the
    // directive was actually wired that would have sent `compact_20260112` to models
    // that do not accept it, 400-ing the whole turn. `compact_20260112` is the SDK's own name
    // for the key, sibling to `clear_tool_uses_20250919` read on the next line.
    serverSideCompaction: contextManagement?.compact_20260112?.supported === true,
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
