import type { ProviderStatus } from "@clawdparty/contracts";
import type { ProviderAdapter } from "./contract.js";
import { buildAdapters } from "./index.js";

/**
 * `GET /models` — every configured provider, with what it can serve on THIS host.
 *
 * NEVER throws and never omits. An unavailable provider is REPORTED with a reason
 * and an actionable remedy ; dropping it from the list is what
 * produces "the model picker is just empty" with nothing to explain why, and that
 * was the failure mode the requirement was written against.
 *
 * `credentialSource` is a source IDENTITY. No value crosses this boundary.
 */

export function configuredAdapters(): ProviderAdapter[] {
  // One line, from the registry. Adding an adapter is a registration there rather than an
  // edit here — which was the claim this function's previous comment made about a hardcoded
  // single-element array.
  return buildAdapters();
}

export async function listProviders(
  adapters: ProviderAdapter[] = configuredAdapters(),
): Promise<{ providers: ProviderStatus[] }> {
  const providers = await Promise.all(adapters.map((adapter) => describe(adapter)));
  return { providers };
}

async function describe(adapter: ProviderAdapter): Promise<ProviderStatus> {
  try {
    const probe = await adapter.probe();
    if (!probe.available) {
      return {
        id: adapter.id,
        displayName: adapter.displayName,
        available: false,
        reason: probe.reason,
        remedy: probe.remedy,
        models: [],
      };
    }

    const models = await adapter.listModels();
    return {
      id: adapter.id,
      displayName: adapter.displayName,
      available: true,
      credentialSource: probe.credentialSource,
      models: models.map((model) => ({
        id: model.id,
        displayName: model.displayName,
        capabilities: model.capabilities,
      })),
    };
  } catch (err) {
    // A provider that throws is still reported. The alternative — a 500 from
    // /models — takes down the picker for EVERY provider because one misbehaved.
    return {
      id: adapter.id,
      displayName: adapter.displayName,
      available: false,
      reason: "unreachable",
      remedy: `Discovery failed: ${String(err)}. Check network access to this provider and retry.`,
      models: [],
    };
  }
}
