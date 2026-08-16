import { describe, expect, it } from "vitest";
import type { ProviderRequest } from "../../src/providers/contract.js";
import { toConverseInput } from "../../src/providers/converse_request.js";

/**
 * Translate a provider-neutral `ProviderRequest` into `ConverseStreamCommand` input.
 *
 * The subtle part, and the reason this is its own tested module: a Converse run's
 * `req.messages` is a MIX of two block shapes. The loop writes ANTHROPIC-shaped blocks for
 * the human's prompt (`{type:"text"}`) and tool results (`{type:"tool_result"}`), while
 * `converse_stream.ts` stored the assistant's own turns as CONVERSE-shaped blocks (`{text}`,
 * `{toolUse}`) — verbatim, per R6. So the adapter has to accept both and emit one Converse
 * shape, or a follow-up turn sends Bedrock a body it rejects.
 */

const signal = new AbortController().signal;

/** The SDK types `messages` as optional; every request we build has it. */
function messagesOf(input: { messages?: unknown[] }): Array<{
  role?: string;
  content?: unknown[];
}> {
  if (!input.messages) throw new Error("expected messages");
  return input.messages as Array<{ role?: string; content?: unknown[] }>;
}

function req(over: Partial<ProviderRequest>): ProviderRequest {
  return {
    model: "us.openai.gpt-5.6-sol",
    maxTokens: 1024,
    system: [{ type: "text", text: "You are a test." }],
    messages: [],
    tools: [],
    cacheBreakpoints: [],
    signal,
    ...over,
  };
}

describe("system and inference config", () => {
  it("moves system blocks to Converse's system field, text only", () => {
    const input = toConverseInput(req({ system: [{ type: "text", text: "be brief" }] }));
    expect(input.system).toEqual([{ text: "be brief" }]);
  });

  it("carries maxTokens into inferenceConfig", () => {
    expect(toConverseInput(req({ maxTokens: 512 })).inferenceConfig).toEqual({ maxTokens: 512 });
  });

  it("passes the model id through unchanged — it belongs in the request, not a URL", () => {
    expect(toConverseInput(req({ model: "us.amazon.nova-pro-v1:0" })).modelId).toBe(
      "us.amazon.nova-pro-v1:0",
    );
  });
});

describe("tools", () => {
  it("wraps each tool schema in a toolSpec with its JSON schema", () => {
    const input = toConverseInput(
      req({
        tools: [
          {
            name: "read_file",
            description: "Read a file.",
            input_schema: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
      }),
    );

    expect(input.toolConfig?.tools).toEqual([
      {
        toolSpec: {
          name: "read_file",
          description: "Read a file.",
          inputSchema: { json: { type: "object", properties: { path: { type: "string" } } } },
        },
      },
    ]);
  });

  it("gives a CANONICAL schema-less tool an explicit object schema", () => {
    // `bash` and the editor are declared the Anthropic way — a `type` and no `input_schema`,
    // because Anthropic models know the shape. Converse models do not, and Converse rejects a
    // toolSpec whose `inputSchema.json.type` is not "object" (the ValidationException that
    // brought this here). So the harness's own schema for each is supplied.
    const bash = toConverseInput(req({ tools: [{ type: "bash_20250124", name: "bash" }] }));
    const spec = bash.toolConfig?.tools?.[0] as {
      toolSpec: { name: string; inputSchema: { json: { type?: string; properties?: object } } };
    };

    expect(spec.toolSpec.name).toBe("bash");
    expect(spec.toolSpec.inputSchema.json.type).toBe("object");
    expect(spec.toolSpec.inputSchema.json.properties).toHaveProperty("command");
  });

  it("gives the editor its command/path schema so the model produces input the executor accepts", () => {
    const input = toConverseInput(
      req({ tools: [{ type: "text_editor_20250728", name: "str_replace_based_edit_tool" }] }),
    );
    const json = (
      input.toolConfig?.tools?.[0] as {
        toolSpec: { inputSchema: { json: Record<string, unknown> } };
      }
    ).toolSpec.inputSchema.json;

    // The schema MUST match `TextEditorInput`, or the model emits fields the executor ignores.
    expect(json.type).toBe("object");
    expect(json.properties).toHaveProperty("command");
    expect(json.properties).toHaveProperty("path");
    expect(json.required).toEqual(["command", "path"]);
  });

  it("forces type:object onto a client schema that omits it", () => {
    // Defensive: a JSON Schema object without an explicit `type` is still an object, but
    // Converse demands the field literally. Never send one it will reject.
    const input = toConverseInput(
      req({ tools: [{ name: "x", input_schema: { properties: { a: { type: "string" } } } }] }),
    );
    const json = (
      input.toolConfig?.tools?.[0] as { toolSpec: { inputSchema: { json: { type?: string } } } }
    ).toolSpec.inputSchema.json;
    expect(json.type).toBe("object");
  });

  it("DROPS a server tool it cannot express (web_search), rather than sending an invalid spec", () => {
    // web_search/web_fetch are Anthropic server tools with no client executor and no JSON
    // schema. They are already withheld on Converse (serverSideTools all false), but if one
    // arrived it must be dropped, not sent as `{}` — which is the exact crash.
    const input = toConverseInput(
      req({ tools: [{ type: "web_search_20250305", name: "web_search" }] }),
    );
    expect(input.toolConfig).toBeUndefined();
  });

  it("omits toolConfig entirely when there are no tools", () => {
    // Converse rejects an empty tools array; absent is the correct shape, and it is also the
    // shape a chat-only turn on a streaming-limited model must send.
    expect(toConverseInput(req({ tools: [] })).toolConfig).toBeUndefined();
  });
});

describe("the human's turn (Anthropic-shaped blocks)", () => {
  it("translates a text block", () => {
    const input = toConverseInput(
      req({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
    );
    expect(messagesOf(input)).toEqual([{ role: "user", content: [{ text: "hi" }] }]);
  });

  it("translates a tool_result block, mapping is_error to a status", () => {
    const input = toConverseInput(
      req({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: [{ type: "text", text: "file contents" }],
                is_error: false,
              },
            ],
          },
        ],
      }),
    );

    expect(messagesOf(input)[0]?.content).toEqual([
      { toolResult: { toolUseId: "t1", content: [{ text: "file contents" }], status: "success" } },
    ]);
  });

  it("marks a failed tool_result as an error status", () => {
    const input = toConverseInput(
      req({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: [{ type: "text", text: "boom" }],
                is_error: true,
              },
            ],
          },
        ],
      }),
    );
    expect(
      (messagesOf(input)[0]?.content?.[0] as { toolResult: { status: string } }).toolResult.status,
    ).toBe("error");
  });
});

describe("the assistant's own prior turn (Converse-shaped blocks, verbatim)", () => {
  it("passes a Converse text block through unchanged", () => {
    const input = toConverseInput(
      req({ messages: [{ role: "assistant", content: [{ text: "already converse" }] }] }),
    );
    expect(messagesOf(input)[0]?.content).toEqual([{ text: "already converse" }]);
  });

  it("passes a Converse toolUse block through, since that is what it echoes back", () => {
    const toolUse = { toolUse: { toolUseId: "t1", name: "read_file", input: { path: "/x" } } };
    const input = toConverseInput(req({ messages: [{ role: "assistant", content: [toolUse] }] }));
    // The toolUse in the assistant turn must match the toolResult id in the next user turn, or
    // Bedrock rejects the pair. Reconstructing it in another shape is what R6 forbids.
    expect(messagesOf(input)[0]?.content).toEqual([toolUse]);
  });

  it("drops a redacted-reasoning block rather than sending bytes that will not round-trip", () => {
    // The encrypted reasoning was stored verbatim, but a Uint8Array does not survive JSON
    // storage as a Uint8Array, and Bedrock rejects a malformed reasoningContent. Reasoning is
    // not required to echo for the next turn to be valid, so dropping it is the safe choice —
    // and it is recorded here so the decision is visible, not accidental.
    const input = toConverseInput(
      req({
        messages: [
          {
            role: "assistant",
            content: [
              { reasoningContent: { redactedContent: { __bytes_b64: "AAAA" } } },
              { text: "answer" },
            ],
          },
        ],
      }),
    );
    expect(messagesOf(input)[0]?.content).toEqual([{ text: "answer" }]);
  });
});

describe("a full multi-turn exchange", () => {
  it("keeps the mixed shapes coherent across turns", () => {
    const input = toConverseInput(
      req({
        messages: [
          { role: "user", content: [{ type: "text", text: "read /x" }] },
          {
            role: "assistant",
            content: [{ toolUse: { toolUseId: "t1", name: "read_file", input: { path: "/x" } } }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: [{ type: "text", text: "ok" }],
                is_error: false,
              },
            ],
          },
        ],
      }),
    );

    expect(messagesOf(input)).toEqual([
      { role: "user", content: [{ text: "read /x" }] },
      {
        role: "assistant",
        content: [{ toolUse: { toolUseId: "t1", name: "read_file", input: { path: "/x" } } }],
      },
      {
        role: "user",
        content: [
          { toolResult: { toolUseId: "t1", content: [{ text: "ok" }], status: "success" } },
        ],
      },
    ]);
  });

  it("never emits an empty content array for a message", () => {
    // A message whose only block was dropped (e.g. redacted reasoning) would leave empty
    // content, which Bedrock rejects. Such a message is omitted entirely.
    const input = toConverseInput(
      req({
        messages: [
          {
            role: "assistant",
            content: [{ reasoningContent: { redactedContent: { __bytes_b64: "AA" } } }],
          },
          { role: "user", content: [{ type: "text", text: "still here" }] },
        ],
      }),
    );
    expect(messagesOf(input)).toEqual([{ role: "user", content: [{ text: "still here" }] }]);
  });
});
