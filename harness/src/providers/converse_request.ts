import type { ConverseStreamCommandInput } from "@aws-sdk/client-bedrock-runtime";
import { converseSchemaFor } from "../tools/converse_schemas.js";
import type { ProviderRequest, ToolSchema } from "./contract.js";

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
  const tools: Tool[] = [];
  for (const tool of req.tools) {
    const json = converseToolJson(tool);
    // A tool with no expressible object schema is DROPPED, not sent as `{}`. Converse rejects
    // a toolSpec whose `inputSchema.json.type` is not "object" with a run-killing
    // ValidationException — the exact failure that surfaced `bedrock-converse`. web_search /
    // web_fetch are the case: Anthropic server tools with no client executor, already withheld
    // from Converse (serverSideTools false) but dropped here too as a backstop.
    if (json === null) continue;
    tools.push({
      toolSpec: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: { json },
      },
    } as Tool);
  }

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
    // NO `status` field. Some Converse models (Writer Palmyra measured) reject it outright —
    // `ValidationException: This model doesn't support the status field` — and Converse treats
    // an absent status as success, so omitting it is universal and lossless for the common
    // case. A failed result is instead marked in the TEXT, so every model still sees the tool
    // errored even without the structured flag.
    return {
      toolResult: {
        toolUseId: String(b.tool_use_id ?? ""),
        content: anthropicToolResultContent(b.content, b.is_error === true),
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
    // The echo rules are the OPPOSITE of what the two shapes suggest, and both were measured.
    // ENCRYPTED bytes are accepted and worth sending: the echoing turn reuses the
    // reasoning state instead of re-deriving it. PLAINTEXT reasoning is refused outright —
    // `ValidationException: User messages cannot contain reasoning content` from DeepSeek R1,
    // against a control turn without it that answered — so echoing it breaks turn two.
    const reasoning = b.reasoningContent as { redactedContent?: unknown };
    const bytes = decodeBytes(reasoning.redactedContent);
    return bytes ? ({ reasoningContent: { redactedContent: bytes } } as ContentBlock) : null;
  }

  // Unknown shape: dropping it is safer than forwarding something Bedrock rejects, and the
  // durable record still holds the original verbatim.
  return null;
}

/**
 * Encrypted reasoning bytes from the surface, or null when there are none to send.
 *
 * `converse_stream` stores them as `{__bytes_b64}` so they survive JSON storage. A surface
 * written before that carries `{"0":114,…}` — the numeric-key wreckage of a stringified
 * Uint8Array — and is DROPPED rather than reassembled: Bedrock rejects a malformed
 * reasoningContent, and a turn without its reasoning still runs.
 */
function decodeBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value.length > 0 ? value : null;
  const tagged = (value ?? {}) as { __bytes_b64?: unknown };
  if (typeof tagged.__bytes_b64 !== "string" || tagged.__bytes_b64 === "") return null;
  const bytes = new Uint8Array(Buffer.from(tagged.__bytes_b64, "base64"));
  return bytes.length > 0 ? bytes : null;
}

/**
 * The Converse JSON schema for a tool, or null when it has none this provider can use.
 *
 * Three cases: a client tool carries its own `input_schema` (read/glob/grep); a canonical
 * schema-less tool (bash, the editor) gets its explicit schema from `converse_schemas.ts`,
 * co-located with the executor; anything else (web_search/web_fetch) has no expressible schema
 * and is dropped. `type: "object"` is forced even on a client schema that omits it — a JSON
 * Schema object is still an object without it, but Converse demands the field literally.
 */
function converseToolJson(tool: ToolSchema): Record<string, unknown> | null {
  if (tool.input_schema && typeof tool.input_schema === "object") {
    // `type: "object"` LAST so it always wins — a tool input schema is an object schema, and
    // Converse requires the field even when JSON Schema would infer it.
    return { ...(tool.input_schema as Record<string, unknown>), type: "object" };
  }
  return converseSchemaFor(tool.name);
}

function anthropicToolResultContent(content: unknown, isError: boolean): Array<{ text: string }> {
  const parts = Array.isArray(content)
    ? content.map((part) => {
        const p = part as { text?: unknown };
        return { text: typeof p.text === "string" ? p.text : JSON.stringify(part) };
      })
    : [{ text: "" }];
  // The error signal moves from the (unsupported) status field into the text. Prefix the
  // FIRST part only, so the marker is not repeated across a multi-part result.
  if (isError && parts[0]) {
    parts[0] = { text: `[tool error] ${parts[0].text}` };
  }
  return parts;
}
