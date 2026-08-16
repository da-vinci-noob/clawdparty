import type { NeutralMessage } from "./contract.js";

/**
 * Normalize a folded surface into blocks the Anthropic Messages API accepts.
 *
 * The surface stores provider-native content blocks VERBATIM (R6), which was harmless while
 * every provider was Anthropic-shaped. `bedrock-converse` broke that assumption: a session that
 * ran a Converse model holds `{text}` with no `type`, `{toolUse}`, `{toolResult}` and
 * `{reasoningContent}`, and replaying those to the Messages API fails with
 * `400 messages.N.content.0.type: Field required` — observed live when Opus was selected on a
 * session that had run OpenAI.
 *
 * This is the mirror of `converse_request.ts`, and having both is what makes switching models
 * mid-session work in either direction. Each adapter normalizes INBOUND to its own vocabulary;
 * the record keeps whatever the producing provider returned.
 */
export function toAnthropicMessages(messages: NeutralMessage[]): NeutralMessage[] {
  const out: NeutralMessage[] = [];
  for (const message of messages) {
    const content = message.content
      .map((block) => translateBlock(block))
      .filter((block): block is Record<string, unknown> => block !== null);
    // An empty content array is itself a 400, so a message whose blocks were all
    // untranslatable is omitted rather than sent hollow.
    if (content.length > 0) {
      out.push({ role: message.role, content });
    }
  }
  return out;
}

/** One block in Anthropic shape, or null to drop it. */
function translateBlock(block: unknown): Record<string, unknown> | null {
  if (block === null || typeof block !== "object") return null;
  const b = block as Record<string, unknown>;

  // Already Anthropic-shaped — pass through UNTOUCHED. Exactness matters: a thinking block must
  // be echoed back unedited or the API rejects it (R6), so this must not rebuild it.
  if (typeof b.type === "string") return b;

  // --- Converse-shaped (a turn produced by bedrock-converse) ---
  if (typeof b.text === "string") {
    return { type: "text", text: b.text };
  }
  if (b.toolUse) {
    const toolUse = b.toolUse as { toolUseId?: unknown; name?: unknown; input?: unknown };
    return {
      type: "tool_use",
      id: String(toolUse.toolUseId ?? ""),
      name: String(toolUse.name ?? ""),
      input: toolUse.input ?? {},
    };
  }
  if (b.toolResult) {
    const toolResult = b.toolResult as {
      toolUseId?: unknown;
      content?: unknown;
      status?: unknown;
    };
    return {
      type: "tool_result",
      tool_use_id: String(toolResult.toolUseId ?? ""),
      content: toolResultContent(toolResult.content),
      is_error: toolResult.status === "error",
    };
  }
  // Another provider's reasoning. Anthropic thinking blocks require a valid `signature`, which a
  // foreign block has none of, so it would be rejected. Reasoning is not needed for a coherent
  // follow-up — the same call `converse_request` makes for redacted bytes.
  if (b.reasoningContent) return null;

  // Unknown shape: dropping beats sending something the API refuses. The record still holds the
  // original verbatim.
  return null;
}

function toolResultContent(content: unknown): Array<{ type: "text"; text: string }> {
  if (!Array.isArray(content)) return [{ type: "text", text: "" }];
  return content.map((part) => {
    const p = part as { text?: unknown };
    return { type: "text", text: typeof p.text === "string" ? p.text : JSON.stringify(part) };
  });
}
