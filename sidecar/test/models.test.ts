import { describe, expect, it, vi } from "vitest";
import { FALLBACK_MODELS, inferContextWindow, listModels } from "../src/models.js";

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
      { id: "claude-opus-4-8", label: "Claude Opus 4.8", context_window: 1_000_000 },
      { id: "claude-sonnet-5", label: "claude-sonnet-5", context_window: 1_000_000 },
    ]);
  });

  it("prefers the API's max_input_tokens over the inferred window", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            // 1M reported explicitly for a would-be-200K id, and a 200K report honored.
            { id: "claude-mystery-9", display_name: "Mystery", max_input_tokens: 1_000_000 },
            { id: "claude-sonnet-5", display_name: "Sonnet 5", max_input_tokens: 200_000 },
          ],
        }),
        { status: 200 },
      ),
    );
    const res = await listModels(
      { ANTHROPIC_API_KEY: "sk-test" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(res.models).toEqual([
      { id: "claude-mystery-9", label: "Mystery", context_window: 1_000_000 },
      { id: "claude-sonnet-5", label: "Sonnet 5", context_window: 200_000 },
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
    expect(res.models).toEqual([
      { id: "us.anthropic.claude-opus-4-8", label: "Opus 4.8", context_window: 1_000_000 },
    ]);
  });

  it("falls back (never throws) when the Bedrock call fails", async () => {
    send.mockReset().mockRejectedValueOnce(new Error("expired token"));
    const res = await listModels({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-west-2" });
    expect(res.source).toBe("fallback");
    expect(res.models).toEqual(FALLBACK_MODELS);
    expect(res.error).toContain("expired token");
  });

  it("infers the window from a Bedrock inference-profile id", async () => {
    send.mockReset().mockResolvedValueOnce({
      inferenceProfileSummaries: [
        {
          inferenceProfileId: "us.anthropic.claude-sonnet-5-20250101",
          inferenceProfileName: "Sonnet 5",
        },
        {
          inferenceProfileId: "us.anthropic.claude-haiku-4-5-20251001",
          inferenceProfileName: "Haiku 4.5",
        },
      ],
    });
    const res = await listModels({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-west-2" });
    expect(res.models).toEqual([
      { id: "us.anthropic.claude-sonnet-5-20250101", label: "Sonnet 5", context_window: 1_000_000 },
      { id: "us.anthropic.claude-haiku-4-5-20251001", label: "Haiku 4.5", context_window: 200_000 },
    ]);
  });
});

describe("FALLBACK_MODELS windows", () => {
  it("carries the right native context window per model", () => {
    const byId = Object.fromEntries(FALLBACK_MODELS.map((m) => [m.id, m.context_window]));
    expect(byId["claude-opus-4-8"]).toBe(1_000_000);
    expect(byId["claude-sonnet-5"]).toBe(1_000_000);
    expect(byId["claude-haiku-4-5-20251001"]).toBe(200_000);
  });
});

describe("inferContextWindow", () => {
  it("maps 1M families (plain + Bedrock inference-profile ids) to 1,000,000", () => {
    expect(inferContextWindow("claude-opus-4-8")).toBe(1_000_000);
    expect(inferContextWindow("claude-sonnet-5")).toBe(1_000_000);
    expect(inferContextWindow("us.anthropic.claude-sonnet-5-20250101")).toBe(1_000_000);
    expect(inferContextWindow("us.anthropic.claude-opus-4-7")).toBe(1_000_000);
    expect(inferContextWindow("claude-fable-5")).toBe(1_000_000);
  });

  it("maps haiku and unknown ids to 200,000", () => {
    expect(inferContextWindow("claude-haiku-4-5-20251001")).toBe(200_000);
    expect(inferContextWindow("us.anthropic.claude-haiku-4-5")).toBe(200_000);
    expect(inferContextWindow("some-future-model")).toBe(200_000);
  });
});
