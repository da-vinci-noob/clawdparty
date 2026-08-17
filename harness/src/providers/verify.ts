import { classifyStreamError } from "./anthropic_family.js";
import type { ProviderAdapter, Usage } from "./contract.js";
import { configuredAdapters } from "./discovery.js";

/**
 * Verify a provider by USING it.
 *
 * `probe()` answers "is there a credential and a region" — presence, which is what model discovery
 * needs and is not what "will a run work?" means. Two measured cases on this host where presence
 * said yes and the request said no: `us.amazon.nova-premier-v1:0` is refused with an entitlement
 * error despite a valid credential, and the `linear` MCP server answered `invalid_token` while
 * being correctly configured. A settings tab built on `probe()` alone would report both as fine.
 *
 * So this sends the smallest real request through the adapter's own `stream()` — the same path a
 * run takes, so a pass means a run would be accepted. It costs a handful of tokens, and the result
 * reports them, because a check whose cost is hidden is a check people stop trusting.
 */

/** One token of output is enough to prove the request was accepted. */
export const VERIFY_MAX_TOKENS = 1;

/** Short, so a verification cannot become a paragraph if a model ignores the token cap. */
const VERIFY_PROMPT = "Reply with the single character: k";

export interface VerifyResult {
  id: string;
  displayName: string;
  ok: boolean;
  /** The model the request was sent with, when one was reachable. */
  model?: string;
  credentialSource?: string;
  /** Why it did not even get sent: the probe's reason, or ours. */
  reason?: string;
  remedy?: string;
  /** The provider's own message when the request WAS sent and refused. */
  error?: string;
  /** What the check spent, so the cost is stated rather than implied. */
  usage?: Usage;
  durationMs?: number;
}

export async function verifyProvider(
  adapter: ProviderAdapter,
  model?: string,
  now: () => number = () => Date.now(),
): Promise<VerifyResult> {
  const started = now();
  const base = { id: adapter.id, displayName: adapter.displayName };

  const probe = await adapter.probe();
  if (!probe.available) {
    // Nothing to learn from sending it: the adapter already knows there is no credential to
    // present, and a request would fail for a reason we can already name.
    return { ...base, ok: false, reason: probe.reason, remedy: probe.remedy };
  }

  const models = await adapter.listModels();
  if (models.length === 0) {
    // Available but serving nothing — a real state for an entitled account with no model access,
    // and it must not read as a pass.
    return { ...base, ok: false, reason: "no_models", credentialSource: probe.credentialSource };
  }

  const chosen = model ?? (models[0]?.id as string);
  if (!models.some((candidate) => candidate.id === chosen)) {
    return {
      ...base,
      ok: false,
      reason: "unknown_model",
      credentialSource: probe.credentialSource,
    };
  }

  try {
    const usage = await sendMinimalTurn(adapter, chosen);
    return {
      ...base,
      ok: true,
      model: chosen,
      credentialSource: probe.credentialSource,
      ...(usage ? { usage } : {}),
      durationMs: now() - started,
    };
  } catch (err) {
    // CLASSIFIED, like every other failure path in the harness. This was the one place a failure on a
    // GOOD credential came back as raw vendor text: a live 429 arrived as
    // `{"error":{"type":"rate_limit_error","message":"Error"}}` — the vendor's own `message` is the
    // word "Error" — so the field meant to carry the diagnostic carried nothing, while the harness
    // already knew a 429 means wait and retry.
    const classified = classifyStreamError(err, adapter.failureHints);
    return {
      ...base,
      ok: false,
      model: chosen,
      credentialSource: probe.credentialSource,
      reason: classified.kind,
      remedy: classified.remedy,
      // KEPT alongside the classification, never replaced by it: the provider's own words carry the
      // `request_id`, which is what a vendor support thread needs and no classifier can reconstruct.
      error: err instanceof Error ? err.message : String(err),
      durationMs: now() - started,
    };
  }
}

async function sendMinimalTurn(adapter: ProviderAdapter, model: string): Promise<Usage | null> {
  let usage: Usage | null = null;
  const stream = adapter.stream({
    model,
    maxTokens: VERIFY_MAX_TOKENS,
    system: [],
    messages: [{ role: "user", content: [{ type: "text", text: VERIFY_PROMPT }] }],
    tools: [],
    cacheBreakpoints: [],
    signal: new AbortController().signal,
  });
  for await (const event of stream) {
    if (event.t === "message_delta") usage = event.usage;
  }
  return usage;
}

/** Every configured provider, verified concurrently — one slow provider must not hide the others. */
export async function verifyProviders(
  adapters: ProviderAdapter[] = configuredAdapters(),
): Promise<{ providers: VerifyResult[] }> {
  const providers = await Promise.all(adapters.map((adapter) => verifyProvider(adapter)));
  return { providers };
}
