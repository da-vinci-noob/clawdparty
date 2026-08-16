import type { ConverseStreamCommandInput } from "@aws-sdk/client-bedrock-runtime";
import type { ProviderRequest } from "./contract.js";

/**
 * `ProviderRequest` → `ConverseStreamCommand` input.
 *
 * The request the loop hands an adapter carries VERBATIM content blocks (R6), and for a
 * Converse run those blocks are of TWO shapes at once:
 *
 *  - the loop's own writes are ANTHROPIC-shaped — `{type:"text"}` for the human prompt,
 *    `{type:"tool_result", tool_use_id, content, is_error}` for a tool result;
 *  - the assistant's prior turns were stored by `converse_stream.ts` as CONVERSE-shaped
 *    blocks — `{text}`, `{toolUse}`, `{reasoningContent}` — because that is what the mapper
 *    produced and the surface keeps unmodified.
 *
 * So this translates the Anthropic shapes and passes the Converse ones through. Getting it
 * wrong is silent until the SECOND turn, when a follow-up request carries a tool_result Bedrock
 * cannot match to its tool_use and rejects the whole body.
 */

type ConverseMessage = NonNullable<ConverseStreamCommandInput["messages"]>[number];
type ContentBlock = NonNullable<ConverseMessage["content"]>[number];

export function toConverseInput(req: ProviderRequest): ConverseStreamCommandInput {
  const messages: ConverseMessage[] = [];
  for (const message of req.messages) {
    const content = message.content
      .map((block) => translateBlock(block))
      .filter((block): block is ContentBlock => block !== null);
    // A message whose blocks were all dropped (e.g. redacted-only reasoning) would send empty
    // content, which Bedrock rejects. Omit it — an assistant turn that contributed nothing the
    // next request can carry does not need to be replayed.
    if (content.length > 0) {
      messages.push({ role: message.role, content });
    }
  }

  type Tool = NonNullable<NonNullable<ConverseStreamCommandInput["toolConfig"]>["tools"]>[number];
  const tools = req.tools.map(
    (tool) =>
      ({
        toolSpec: {
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: { json: (tool.input_schema ?? {}) as Record<string, unknown> },
        },
      }) as Tool,
  );

  const input: ConverseStreamCommandInput = {
    modelId: req.model,
    system: req.system.map((block) => ({ text: block.text })),
    messages,
    inferenceConfig: { maxTokens: req.maxTokens },
  };
  // Converse rejects an empty tools array — a chat-only turn (or a streaming-limited model
  // used without tools) must send NO toolConfig, not an empty one.
  if (tools.length > 0) {
    input.toolConfig = { tools };
  }
  return input;
}

/**
 * One content block to its Converse form, or null to drop it.
 *
 * Detection is by shape rather than a discriminant, because the two vocabularies do not share
 * one: Anthropic blocks carry `type`, Converse blocks are identified by their sole key.
 */
function translateBlock(block: unknown): ContentBlock | null {
  if (block === null || typeof block !== "object") return null;
  const b = block as Record<string, unknown>;

  // --- Anthropic-shaped (the loop's own writes) ---
  if (b.type === "text" && typeof b.text === "string") {
    return { text: b.text } as ContentBlock;
  }
  if (b.type === "tool_result") {
    return {
      toolResult: {
        toolUseId: String(b.tool_use_id ?? ""),
        content: anthropicToolResultContent(b.content),
        status: b.is_error ? "error" : "success",
      },
    } as ContentBlock;
  }
  if (b.type === "tool_use") {
    // Rare — the loop stores Converse-shaped assistant turns, so an Anthropic tool_use only
    // appears if a run's provider changed mid-session. Translate rather than drop, so the
    // paired tool_result still has its tool_use.
    return {
      toolUse: { toolUseId: String(b.id ?? ""), name: String(b.name ?? ""), input: b.input },
    } as ContentBlock;
  }

  // --- Converse-shaped (the assistant's own prior turns, verbatim) ---
  if (typeof b.text === "string" && !("type" in b)) {
    return { text: b.text } as ContentBlock;
  }
  if (b.toolUse) {
    return { toolUse: b.toolUse } as ContentBlock;
  }
  if (b.reasoningContent) {
    const reasoning = b.reasoningContent as { reasoningText?: unknown; redactedContent?: unknown };
    // Plain reasoning text can echo back; encrypted bytes cannot — a Uint8Array does not
    // survive JSON storage as itself, and Bedrock rejects a malformed reasoningContent.
    // Reasoning is not required for a valid follow-up turn, so a redacted block is dropped.
    if (reasoning.reasoningText) {
      return { reasoningContent: { reasoningText: reasoning.reasoningText } } as ContentBlock;
    }
    return null;
  }

  // Unknown shape: dropping it is safer than forwarding something Bedrock rejects, and the
  // durable record still holds the original verbatim.
  return null;
}

function anthropicToolResultContent(content: unknown): Array<{ text: string }> {
  if (!Array.isArray(content)) return [{ text: "" }];
  return content.map((part) => {
    const p = part as { text?: unknown };
    return { text: typeof p.text === "string" ? p.text : JSON.stringify(part) };
  });
}
