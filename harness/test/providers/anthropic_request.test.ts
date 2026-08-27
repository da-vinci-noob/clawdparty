import { describe, expect, it } from "vitest";
import { toAnthropicMessages } from "../../src/providers/anthropic_request.js";
import type { NeutralMessage } from "../../src/providers/contract.js";

/**
 * A session whose surface holds ANOTHER provider's block shapes must still run on Anthropic.
 *
 * The surface stores provider-native content blocks VERBATIM (R6), so a session that ran a
 * Converse model holds Converse-shaped blocks: `{text}` with no `type`, `{toolUse}`,
 * `{toolResult}`, `{reasoningContent}`. Switching that session to an Anthropic model replayed
 * them straight to the Messages API, which rejects the request:
 *
 *     400 messages.1.content.0.type: Field required
 *
 * Observed live (run 79, Opus on a session that had run OpenAI via Converse). Before
 * bedrock-converse existed every provider was Anthropic-shaped, so the surface was universally
 * compatible and no translation was needed. `converse_request.ts` already normalizes the other
 * direction; this is the missing mirror, and it is what makes switching models mid-session work
 * BOTH ways.
 */

const anthropicText = { type: "text", text: "hello" };
const anthropicToolUse = { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } };
const anthropicToolResult = {
  type: "tool_result",
  tool_use_id: "t1",
  content: [{ type: "text", text: "ok" }],
  is_error: false,
};

const msg = (role: "user" | "assistant", content: unknown[]): NeutralMessage => ({ role, content });
const blocksOf = (out: NeutralMessage[]) => out.flatMap((m) => m.content);

describe("Anthropic-shaped blocks pass through untouched", () => {
  it("keeps text, tool_use, tool_result and thinking verbatim", () => {
    const thinking = { type: "thinking", thinking: "hmm", signature: "sig" };
    const out = toAnthropicMessages([
      msg("user", [anthropicText]),
      msg("assistant", [thinking, anthropicToolUse]),
      msg("user", [anthropicToolResult]),
    ]);

    // R6: a thinking block must be echoed back UNEDITED or the API rejects it, so pass-through
    // has to be exact, not reconstructed.
    expect(blocksOf(out)).toEqual([anthropicText, thinking, anthropicToolUse, anthropicToolResult]);
  });
});

describe("Converse-shaped blocks are translated", () => {
  it("gives a bare {text} block the type the API requires", () => {
    // The exact cause of `messages.1.content.0.type: Field required`.
    const out = toAnthropicMessages([msg("assistant", [{ text: "from converse" }])]);
    expect(blocksOf(out)).toEqual([{ type: "text", text: "from converse" }]);
  });

  it("translates a Converse {toolUse} to a canonical tool_use", () => {
    const out = toAnthropicMessages([
      msg("assistant", [{ toolUse: { toolUseId: "c1", name: "bash", input: { command: "ls" } } }]),
    ]);
    // The id must survive, or the paired tool_result matches nothing and the API 400s on that
    // instead.
    expect(blocksOf(out)).toEqual([
      { type: "tool_use", id: "c1", name: "bash", input: { command: "ls" } },
    ]);
  });

  it("translates a Converse {toolResult} to a canonical tool_result", () => {
    const out = toAnthropicMessages([
      msg("user", [{ toolResult: { toolUseId: "c1", content: [{ text: "done" }] } }]),
    ]);
    expect(blocksOf(out)).toEqual([
      {
        type: "tool_result",
        tool_use_id: "c1",
        content: [{ type: "text", text: "done" }],
        is_error: false,
      },
    ]);
  });

  it("marks a Converse error result so the model still sees the failure", () => {
    const out = toAnthropicMessages([
      msg("user", [
        { toolResult: { toolUseId: "c1", content: [{ text: "boom" }], status: "error" } },
      ]),
    ]);
    expect((blocksOf(out)[0] as { is_error: boolean }).is_error).toBe(true);
  });

  it("DROPS another provider's reasoning content", () => {
    // Anthropic thinking blocks require a valid `signature`; a foreign reasoning block has none
    // and is rejected. Reasoning is not needed for a coherent follow-up, so dropping it is the
    // safe direction — the same decision converse_request makes for redacted bytes.
    const out = toAnthropicMessages([
      msg("assistant", [
        { reasoningContent: { reasoningText: { text: "thinking" } } },
        { text: "the answer" },
      ]),
    ]);
    expect(blocksOf(out)).toEqual([{ type: "text", text: "the answer" }]);
  });
});

describe("messages that would be rejected are omitted", () => {
  it("drops a message whose blocks were all untranslatable", () => {
    // An empty content array is itself a 400.
    const out = toAnthropicMessages([
      msg("assistant", [{ reasoningContent: { redactedContent: "AAA" } }]),
      msg("user", [anthropicText]),
    ]);
    expect(out).toEqual([{ role: "user", content: [anthropicText] }]);
  });

  it("drops an unknown block shape rather than sending it", () => {
    const out = toAnthropicMessages([msg("assistant", [{ somethingNew: 1 }, anthropicText])]);
    expect(blocksOf(out)).toEqual([anthropicText]);
  });
});

describe("a real cross-provider session", () => {
  it("normalizes a mixed surface into one valid Anthropic conversation", () => {
    // What session 38 actually held: Anthropic-shaped writes from the loop (the human prompt,
    // tool results) interleaved with Converse-shaped assistant turns.
    const out = toAnthropicMessages([
      msg("user", [{ type: "text", text: "run ls" }]),
      msg("assistant", [
        { text: "I'll do that." },
        { toolUse: { toolUseId: "c1", name: "bash", input: {} } },
      ]),
      msg("user", [anthropicToolResult]),
    ]);

    // Every block now carries a `type`, which is the whole requirement.
    for (const block of blocksOf(out)) {
      expect(block).toHaveProperty("type");
    }
    expect(out).toHaveLength(3);
  });
});
