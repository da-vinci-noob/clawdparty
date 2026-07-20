import { describe, expect, it, vi } from "vitest";
import { FALLBACK_MODELS, listModels } from "../src/models.js";

// The Bedrock control-plane client is mocked so the test never touches real AWS
// (the dev host may or may not have live SSO creds). `send` is hoisted so the
// vi.mock factory (itself hoisted) can close over it.
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-bedrock", () => ({
  BedrockClient: vi.fn().mockImplementation(() => ({ send })),
  ListInferenceProfilesCommand: vi.fn().mockImplementation((input) => input),
}));

describe("listModels — Anthropic API path", () => {
  it("maps the /v1/models response when an API key is present", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
            { id: "claude-sonnet-5" },
          ],
        }),
        { status: 200 },
      ),
    );
    const res = await listModels(
      { ANTHROPIC_API_KEY: "sk-test" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(res.source).toBe("anthropic");
    expect(res.models).toEqual([
      { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
      { id: "claude-sonnet-5", label: "claude-sonnet-5" },
    ]);
  });

  it("falls back (never throws) when no API credential is in the env", async () => {
    const fetchImpl = vi.fn();
    const res = await listModels({}, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.source).toBe("fallback");
    expect(res.models).toEqual(FALLBACK_MODELS);
  });

  it("falls back with an error tag when the API call fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    const res = await listModels(
      { ANTHROPIC_API_KEY: "sk-bad" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(res.source).toBe("fallback");
    expect(res.models).toEqual(FALLBACK_MODELS);
    expect(res.error).toContain("401");
  });
});

describe("listModels — Bedrock path", () => {
  it("maps Anthropic inference profiles, skipping non-Anthropic ids", async () => {
    send.mockReset().mockResolvedValueOnce({
      inferenceProfileSummaries: [
        { inferenceProfileId: "us.anthropic.claude-opus-4-8", inferenceProfileName: "Opus 4.8" },
        { inferenceProfileId: "us.meta.llama", inferenceProfileName: "Llama" },
      ],
    });
    const res = await listModels({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-west-2" });
    expect(res.source).toBe("bedrock");
    expect(res.models).toEqual([{ id: "us.anthropic.claude-opus-4-8", label: "Opus 4.8" }]);
  });

  it("falls back (never throws) when the Bedrock call fails", async () => {
    send.mockReset().mockRejectedValueOnce(new Error("expired token"));
    const res = await listModels({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-west-2" });
    expect(res.source).toBe("fallback");
    expect(res.models).toEqual(FALLBACK_MODELS);
    expect(res.error).toContain("expired token");
  });
});
