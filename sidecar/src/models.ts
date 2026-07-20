// models.ts — runtime model discovery. The sidecar is the only process with the
// Agent SDK's auth env (CLAUDE_CODE_USE_BEDROCK, AWS_PROFILE/AWS_REGION) and the
// read-only ~/.aws + ~/.claude mounts, so it is the only place that can enumerate
// the models actually available to THIS host's login. On Bedrock we list the
// Anthropic system-defined inference profiles (their ids are exactly the strings
// the SDK's `options.model` needs); on a direct API key/OAuth login we query the
// Anthropic /v1/models API. Any failure (expired SSO, missing perms, no network)
// degrades to a static fallback list so the picker NEVER breaks — this endpoint
// must not 500.

export interface ModelInfo {
  id: string;
  label: string;
}

export interface ModelList {
  models: ModelInfo[];
  // "bedrock" | "anthropic" | "fallback" — lets the UI show where the list came
  // from (and surface a soft warning when we fell back).
  source: string;
  // Present only when discovery failed and we returned the fallback list.
  error?: string;
}

// The last-resort list, mirroring the historical hard-coded web dropdown. Plain
// ids (not Bedrock inference-profile ids) — correct for a direct API-key login and
// a safe default the SDK can still resolve via the host's ANTHROPIC_MODEL env.
export const FALLBACK_MODELS: ModelInfo[] = [
  { id: "claude-opus-4-8", label: "Claude Opus 4.8 (most capable)" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5 (balanced)" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (fastest)" },
];

function isBedrock(env: NodeJS.ProcessEnv): boolean {
  const v = env.CLAUDE_CODE_USE_BEDROCK;
  return v === "1" || v === "true";
}

// Enumerate Anthropic inference profiles available to the host's AWS session.
// Uses the Bedrock control-plane client (distinct from bedrock-runtime); creds +
// region resolve from the inherited env and the ~/.aws mount. Dynamically imported
// so the dependency is only loaded on Bedrock hosts.
async function listBedrockModels(env: NodeJS.ProcessEnv): Promise<ModelInfo[]> {
  const { BedrockClient, ListInferenceProfilesCommand } = await import("@aws-sdk/client-bedrock");
  const client = new BedrockClient({ region: env.AWS_REGION });
  const models: ModelInfo[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(
      new ListInferenceProfilesCommand({ typeEquals: "SYSTEM_DEFINED", nextToken }),
    );
    for (const p of res.inferenceProfileSummaries ?? []) {
      const id = p.inferenceProfileId;
      if (!id || !id.toLowerCase().includes("anthropic")) {
        continue; // this app only drives Anthropic (Claude) models
      }
      models.push({ id, label: p.inferenceProfileName ?? id });
    }
    nextToken = res.nextToken;
  } while (nextToken);
  return models;
}

// Enumerate models from the Anthropic API (direct API key or OAuth token login).
async function listAnthropicApiModels(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<ModelInfo[]> {
  const apiKey = env.ANTHROPIC_API_KEY;
  const authToken = env.ANTHROPIC_AUTH_TOKEN ?? env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!apiKey && !authToken) {
    // No usable API credential in the env (e.g. macOS Keychain-only OAuth). We
    // cannot enumerate; the caller falls back to the static list.
    return [];
  }
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  } else if (authToken) {
    headers.authorization = `Bearer ${authToken}`;
  }
  const res = await fetchImpl("https://api.anthropic.com/v1/models?limit=100", { headers });
  if (!res.ok) {
    throw new Error(`anthropic /v1/models returned ${res.status}`);
  }
  const body = (await res.json()) as { data?: { id: string; display_name?: string }[] };
  return (body.data ?? []).map((m) => ({ id: m.id, label: m.display_name ?? m.id }));
}

// Discover the models available to this host's login. Never throws — on any
// failure it returns the fallback list tagged with source "fallback" + the error.
export async function listModels(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelList> {
  const bedrock = isBedrock(env);
  try {
    const models = bedrock
      ? await listBedrockModels(env)
      : await listAnthropicApiModels(env, fetchImpl);
    if (models.length === 0) {
      return { models: FALLBACK_MODELS, source: "fallback" };
    }
    return { models, source: bedrock ? "bedrock" : "anthropic" };
  } catch (err) {
    return { models: FALLBACK_MODELS, source: "fallback", error: String(err) };
  }
}
