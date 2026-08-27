import { AnthropicBedrockAdapter } from "./anthropic_bedrock.js";
import { AnthropicDirectAdapter } from "./anthropic_direct.js";
import { AnthropicOauthAdapter } from "./anthropic_oauth.js";
import { BedrockConverseAdapter } from "./bedrock_converse.js";
import type { ProviderAdapter } from "./contract.js";

/**
 * The adapter registry.
 *
 * Adding a provider is a REGISTRATION, not a branch. That is the property the whole seam
 * exists for: `supervisor.ts` resolves an id through `adapterFor` and the loop reads
 * `capabilities()`, so nothing outside this directory knows an adapter id at all. A
 * `if (provider === "anthropic-bedrock")` anywhere in `loop/` would mean providers had
 * stopped being interchangeable, and `test/adapters/registry.test.ts` asserts none exists.
 *
 * Order is the DEFAULT PREFERENCE order for a host with several logins present, not a
 * credential precedence — credential precedence lives in `credentials/discover.ts` and is
 * the vendor's documented order. Two different orderings for two different questions:
 * "which credential wins within a provider" and "which provider to offer first".
 */

export const ADAPTER_IDS = [
  "anthropic-direct",
  "anthropic-oauth",
  "anthropic-bedrock",
  "bedrock-converse",
] as const;

export type AdapterId = (typeof ADAPTER_IDS)[number];

export interface BuildAdapterOptions {
  /**
   * The AWS named profile Bedrock should authenticate with for THIS caller.
   *
   * Passed through rather than read from the environment inside the adapter, because the
   * harness serves many sessions from one process and the profile decides whose account pays.
   */
  awsProfile?: string;
}

/** Fresh instances per call: each caches its own model capabilities, and a shared cache
 *  across sessions would serve one session's model list to another. */
export function buildAdapters(opts: BuildAdapterOptions = {}): ProviderAdapter[] {
  const awsProfileOpt = opts.awsProfile ? { awsProfile: opts.awsProfile } : {};
  return [
    new AnthropicDirectAdapter(),
    new AnthropicOauthAdapter(),
    new AnthropicBedrockAdapter({ ...awsProfileOpt }),
    // The non-Anthropic Bedrock models. Same per-session AWS profile as the Anthropic Bedrock
    // adapter — the two split the catalogue by vendor, they do not compete for a login.
    new BedrockConverseAdapter({ ...awsProfileOpt }),
  ];
}

/**
 * Resolve by id, or `null` for an unknown one.
 *
 * Null rather than a throw or a silent default: an unknown provider is a caller error that
 * deserves a 4xx naming it, and defaulting to `anthropic-direct` would run someone's prompt
 * against a provider they did not choose and bill an account they did not pick.
 */
export function adapterById(id: string, adapters = buildAdapters()): ProviderAdapter | null {
  return adapters.find((adapter) => adapter.id === id) ?? null;
}

export function isAdapterId(id: string): id is AdapterId {
  return (ADAPTER_IDS as readonly string[]).includes(id);
}
