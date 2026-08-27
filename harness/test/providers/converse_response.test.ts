import type { ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it } from "vitest";
import type { ProviderEvent } from "../../src/providers/contract.js";
import { responseToStreamEvents } from "../../src/providers/converse_response.js";
import { mapConverseStream } from "../../src/providers/converse_stream.js";

/**
 * A non-streaming `Converse` response is replayed as the SAME event vocabulary a stream
 * produces, so one mapper serves both paths.
 *
 * The 8 streaming-limited models (every Llama, Mistral Pixtral, both Writer Palmyra) accept a
 * `toolConfig` on `Converse` but reject it on `ConverseStream`. The adapter serves them by
 * calling `Converse` and turning its single response into synthetic `contentBlockStart` /
 * `contentBlockDelta` / `contentBlockStop` / `messageStop` / `metadata` events — which
 * `mapConverseStream` already knows how to normalize (canonical tool_use shape, tool-input
 * parse, reasoning). Reuse, not a second mapper that could drift from the first.
 *
 * The one thing lost is live text: there is no `ai_text_delta` because the whole answer
 * arrives at once. That is the declared cost of `toolUseWhileStreaming: false`.
 */

async function collect(output: ConverseCommandOutput, model = "m"): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of mapConverseStream(responseToStreamEvents(output), model)) {
    out.push(e);
  }
  return out;
}

const types = (events: ProviderEvent[]) => events.map((e) => e.t);

function response(
  content: unknown[],
  over: Partial<ConverseCommandOutput> = {},
): ConverseCommandOutput {
  return {
    output: { message: { role: "assistant", content: content as never } },
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    $metadata: {},
    ...over,
  } as ConverseCommandOutput;
}

describe("a text-only response", () => {
  it("produces the lifecycle a streamed turn would", async () => {
    const events = await collect(response([{ text: "the answer" }]));

    expect(types(events)[0]).toBe("message_start");
    expect(types(events).slice(-2)).toEqual(["message_delta", "message_stop"]);
    // The text is delivered as a delta so the surface accumulates it exactly as in streaming.
    const text = events
      .filter((e): e is Extract<ProviderEvent, { t: "text_delta" }> => e.t === "text_delta")
      .map((e) => e.text)
      .join("");
    expect(text).toBe("the answer");
  });

  it("carries the model id and the usage", async () => {
    const events = await collect(response([{ text: "hi" }]), "us.meta.llama3-3-70b-instruct-v1:0");
    expect(events[0]).toEqual({ t: "message_start", model: "us.meta.llama3-3-70b-instruct-v1:0" });
    const delta = events.find(
      (e): e is Extract<ProviderEvent, { t: "message_delta" }> => e.t === "message_delta",
    );
    expect(delta?.usage.input_tokens).toBe(10);
    expect(delta?.usage.output_tokens).toBe(4);
  });
});

describe("a tool-use response", () => {
  it("emits a canonical tool_use block the loop can read", async () => {
    const events = await collect(
      response([{ toolUse: { toolUseId: "call_9", name: "bash", input: { command: "ls" } } }], {
        stopReason: "tool_use",
      }),
    );
    const stop = events.find(
      (e): e is Extract<ProviderEvent, { t: "block_stop" }> => e.t === "block_stop",
    );

    // Same canonical `{type:"tool_use", id, name, input}` shape the streaming path yields — the
    // whole point of routing both through mapConverseStream, so the loop extracts the id and
    // the tool_result pairs.
    expect(stop?.block).toMatchObject({
      type: "tool_use",
      id: "call_9",
      name: "bash",
      input: { command: "ls" },
    });
    const delta = events.find(
      (e): e is Extract<ProviderEvent, { t: "message_delta" }> => e.t === "message_delta",
    );
    expect(delta?.stopReason).toBe("tool_use");
  });

  it("round-trips the tool input through the mapper's JSON accumulator", async () => {
    // The response has input as a parsed object; the synthetic delta re-serializes it and the
    // mapper parses it back. A regression here would silently corrupt tool arguments.
    const events = await collect(
      response([{ toolUse: { toolUseId: "t", name: "edit", input: { path: "/x", n: 3 } } }], {
        stopReason: "tool_use",
      }),
    );
    const stop = events.find(
      (e): e is Extract<ProviderEvent, { t: "block_stop" }> => e.t === "block_stop",
    );
    expect((stop?.block as { input: unknown }).input).toEqual({ path: "/x", n: 3 });
  });
});

describe("a mixed response", () => {
  it("keeps text and a tool call in order", async () => {
    const events = await collect(
      response(
        [{ text: "I'll run it." }, { toolUse: { toolUseId: "t", name: "bash", input: {} } }],
        {
          stopReason: "tool_use",
        },
      ),
    );
    const kinds = events
      .filter((e): e is Extract<ProviderEvent, { t: "block_start" }> => e.t === "block_start")
      .map((e) => e.kind);
    expect(kinds).toEqual(["text", "tool_use"]);
  });
});

describe("stop reasons", () => {
  it("maps max_tokens through", async () => {
    const events = await collect(response([{ text: "truncat" }], { stopReason: "max_tokens" }));
    const delta = events.find(
      (e): e is Extract<ProviderEvent, { t: "message_delta" }> => e.t === "message_delta",
    );
    expect(delta?.stopReason).toBe("max_tokens");
  });

  it("settles even when the response has no content", async () => {
    // A refusal or empty completion still has to close the turn, or the loop hangs.
    const events = await collect(response([], { stopReason: "end_turn" }));
    expect(types(events).slice(-2)).toEqual(["message_delta", "message_stop"]);
  });
});
