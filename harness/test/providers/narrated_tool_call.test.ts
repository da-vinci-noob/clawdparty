import type { ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it } from "vitest";
import type { ProviderEvent } from "../../src/providers/contract.js";
import { responseToStreamEvents } from "../../src/providers/converse_response.js";
import { mapConverseStream } from "../../src/providers/converse_stream.js";

/**
 * Some models NARRATE a tool call as text instead of using the tool protocol.
 *
 * Observed live on `us.meta.llama3-3-70b-instruct-v1:0`: asked to run a command, it answered
 * with its native Llama function-call JSON as an ordinary text block —
 * `{"type":"function","name":"bash","parameters":{"command":"echo hi"}}` — so the run
 * "completed" having executed nothing, and the participant saw raw JSON where an answer
 * belonged. Bedrock did not parse it into a `toolUse` block, and the harness took it at its
 * word.
 *
 * Converting it is safe ONLY under guards, because a model may legitimately print JSON that
 * resembles a call: tools must have been offered, the payload must parse, and its `name` must
 * match an OFFERED tool. Anything else stays text. This runs on the non-streaming fallback path
 * only, where the whole block is in hand and there is no live streaming to hold back.
 */

const TOOLS = ["bash", "read", "str_replace_based_edit_tool"];

async function collect(
  content: unknown[],
  toolNames: readonly string[] = TOOLS,
  stopReason = "end_turn",
): Promise<ProviderEvent[]> {
  const output = {
    output: { message: { role: "assistant", content } },
    stopReason,
    usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
    $metadata: {},
  } as ConverseCommandOutput;

  const out: ProviderEvent[] = [];
  for await (const e of mapConverseStream(responseToStreamEvents(output, toolNames), "m")) {
    out.push(e);
  }
  return out;
}

const toolBlocks = (events: ProviderEvent[]) =>
  events
    .filter((e): e is Extract<ProviderEvent, { t: "block_stop" }> => e.t === "block_stop")
    .map((e) => e.block as Record<string, unknown>)
    .filter((b) => b.type === "tool_use");

const textOf = (events: ProviderEvent[]) =>
  events
    .filter((e): e is Extract<ProviderEvent, { t: "text_delta" }> => e.t === "text_delta")
    .map((e) => e.text)
    .join("");

const stopOf = (events: ProviderEvent[]) =>
  events.find((e): e is Extract<ProviderEvent, { t: "message_delta" }> => e.t === "message_delta")
    ?.stopReason;

describe("a narrated call becomes a real tool call", () => {
  it("converts Llama's native function JSON", async () => {
    const events = await collect([
      { text: '{"type": "function", "name": "bash", "parameters": {"command": "echo hi"}}' },
    ]);

    expect(toolBlocks(events)).toHaveLength(1);
    expect(toolBlocks(events)[0]).toMatchObject({
      type: "tool_use",
      name: "bash",
      input: { command: "echo hi" },
    });
  });

  it("reports tool_use as the stop reason so the loop DISPATCHES", async () => {
    // The response said `end_turn`. Without overriding it the loop finishes the run and the
    // tool never executes — which is exactly what "completed having done nothing" was.
    const events = await collect([{ text: '{"name": "bash", "parameters": {"command": "ls"}}' }]);
    expect(stopOf(events)).toBe("tool_use");
  });

  it("gives the call an id, so its result can be paired", async () => {
    const events = await collect([{ text: '{"name": "bash", "parameters": {"command": "ls"}}' }]);
    expect((toolBlocks(events)[0] as { id?: string }).id).toBeTruthy();
  });

  it("accepts `arguments` as well as `parameters`", async () => {
    const events = await collect([{ text: '{"name": "read", "arguments": {"path": "/x"}}' }]);
    expect(toolBlocks(events)[0]).toMatchObject({ name: "read", input: { path: "/x" } });
  });

  it("unwraps a markdown code fence", async () => {
    const events = await collect([
      { text: '```json\n{"name": "bash", "parameters": {"command": "ls"}}\n```' },
    ]);
    expect(toolBlocks(events)).toHaveLength(1);
  });

  it("keeps preceding prose as text and converts only the trailing call", async () => {
    // The shape a participant actually saw: a greeting followed by the JSON.
    const events = await collect([
      {
        text: 'Hi there! What\'s up?\n\n{"type":"function","name":"bash","parameters":{"command":"echo Hello!"}}',
      },
    ]);

    expect(textOf(events).trim()).toBe("Hi there! What's up?");
    expect(toolBlocks(events)).toHaveLength(1);
  });

  it("gives each converted call a DISTINCT id", async () => {
    const events = await collect([
      { text: '{"name": "bash", "parameters": {"command": "a"}}' },
      { text: '{"name": "bash", "parameters": {"command": "b"}}' },
    ]);
    const ids = toolBlocks(events).map((b) => b.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("the guards — text that must stay text", () => {
  it("does not convert when NO tools were offered", async () => {
    const events = await collect(
      [{ text: '{"name": "bash", "parameters": {"command": "ls"}}' }],
      [],
    );
    expect(toolBlocks(events)).toHaveLength(0);
    expect(textOf(events)).toContain('"name"');
  });

  it("does not convert a name that is not an offered tool", async () => {
    // A model discussing some other system's API must not have it executed.
    const events = await collect([
      { text: '{"name": "transfer_funds", "parameters": {"amount": 1000}}' },
    ]);
    expect(toolBlocks(events)).toHaveLength(0);
  });

  it("does not convert prose that merely mentions a tool", async () => {
    const events = await collect([{ text: 'You could use bash with {"command": "ls"} for that.' }]);
    expect(toolBlocks(events)).toHaveLength(0);
  });

  it("does not convert malformed JSON", async () => {
    const events = await collect([{ text: '{"name": "bash", "parameters": {oops}' }]);
    expect(toolBlocks(events)).toHaveLength(0);
  });

  it("does not convert a JSON object with no name", async () => {
    const events = await collect([{ text: '{"command": "ls", "restart": false}' }]);
    expect(toolBlocks(events)).toHaveLength(0);
  });

  it("leaves a REAL toolUse block alone", async () => {
    const events = await collect([
      { toolUse: { toolUseId: "real_1", name: "bash", input: { command: "ls" } } },
    ]);
    expect(toolBlocks(events)).toHaveLength(1);
    // The provider's own id must survive — not be replaced by a synthesized one.
    expect((toolBlocks(events)[0] as { id?: string }).id).toBe("real_1");
  });

  it("preserves an explicit tool_use stop reason", async () => {
    const events = await collect(
      [{ toolUse: { toolUseId: "r", name: "bash", input: {} } }],
      TOOLS,
      "tool_use",
    );
    expect(stopOf(events)).toBe("tool_use");
  });

  it("leaves max_tokens alone when nothing was converted", async () => {
    const events = await collect([{ text: "just prose" }], TOOLS, "max_tokens");
    expect(stopOf(events)).toBe("max_tokens");
  });
});
