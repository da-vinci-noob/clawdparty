import type { ConverseCommandOutput, ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";

/**
 * Replay a NON-streaming `Converse` response as the stream event vocabulary.
 *
 * The streaming-limited models (every Llama, Mistral Pixtral, both Writer Palmyra)
 * accept a `toolConfig` on `Converse` but reject it on `ConverseStream`. The adapter serves a
 * tools turn on them by calling `Converse` and feeding its single response through THIS, so
 * the one mapper (`mapConverseStream`) normalizes both paths — canonical tool_use shape, tool
 * input parse, reasoning — with no second mapper to drift.
 *
 * The synthetic sequence matches what the real stream sends: NO `contentBlockStart` for a text
 * block (the mapper synthesizes the open on the first delta), a `contentBlockStart` carrying
 * id+name for a tool block, tool input as a single JSON-string delta the mapper re-parses, and
 * a closing `messageStop` + `metadata`. The only thing missing versus streaming is
 * incremental `ai_text_delta` — the whole answer is one delta, because it arrived at once.
 */
export async function* responseToStreamEvents(
  output: ConverseCommandOutput,
  _model: string,
): AsyncGenerator<ConverseStreamOutput> {
  yield { messageStart: { role: "assistant" } } as ConverseStreamOutput;

  const content = output.output?.message?.content ?? [];
  let index = 0;
  for (const block of content) {
    const b = block as unknown as Record<string, unknown>;

    if (typeof b.text === "string") {
      // No contentBlockStart for text — matches the wire, where the mapper opens the block on
      // the first delta.
      yield {
        contentBlockDelta: { contentBlockIndex: index, delta: { text: b.text } },
      } as ConverseStreamOutput;
      yield { contentBlockStop: { contentBlockIndex: index } } as ConverseStreamOutput;
      index += 1;
      continue;
    }

    if (b.toolUse) {
      const toolUse = b.toolUse as { toolUseId?: string; name?: string; input?: unknown };
      yield {
        contentBlockStart: {
          contentBlockIndex: index,
          start: { toolUse: { toolUseId: toolUse.toolUseId, name: toolUse.name } },
        },
      } as ConverseStreamOutput;
      // The response carries `input` PARSED; the mapper accumulates a JSON string and parses at
      // block_stop, so re-serialize it into one delta and let the mapper round-trip it.
      yield {
        contentBlockDelta: {
          contentBlockIndex: index,
          delta: { toolUse: { input: JSON.stringify(toolUse.input ?? {}) } },
        },
      } as ConverseStreamOutput;
      yield { contentBlockStop: { contentBlockIndex: index } } as ConverseStreamOutput;
      index += 1;
      continue;
    }

    if (b.reasoningContent) {
      const reasoning = b.reasoningContent as { reasoningText?: { text?: string } };
      const text = reasoning.reasoningText?.text;
      if (typeof text === "string") {
        yield {
          contentBlockDelta: {
            contentBlockIndex: index,
            delta: { reasoningContent: { text } },
          },
        } as ConverseStreamOutput;
        yield { contentBlockStop: { contentBlockIndex: index } } as ConverseStreamOutput;
        index += 1;
      }
      continue;
    }

    // An unknown block shape becomes a raw event via the mapper's fallthrough — forward it
    // rather than dropping it silently.
    yield { contentBlockDelta: { contentBlockIndex: index, delta: {} } } as ConverseStreamOutput;
    index += 1;
  }

  yield { messageStop: { stopReason: output.stopReason ?? "end_turn" } } as ConverseStreamOutput;
  if (output.usage) {
    yield { metadata: { usage: output.usage } } as ConverseStreamOutput;
  }
}
