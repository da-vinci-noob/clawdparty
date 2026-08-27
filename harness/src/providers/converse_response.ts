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
  toolNames: readonly string[] = [],
): AsyncGenerator<ConverseStreamOutput> {
  yield { messageStart: { role: "assistant" } } as ConverseStreamOutput;

  const content = output.output?.message?.content ?? [];
  let index = 0;
  let converted = 0;
  for (const block of content) {
    const b = block as unknown as Record<string, unknown>;

    if (typeof b.text === "string") {
      // A model that NARRATED its tool call as text rather than using the protocol (Llama 3.3
      // measured). Guarded hard — see `narratedToolCall`.
      const narrated = narratedToolCall(b.text, toolNames);
      if (narrated) {
        if (narrated.prose) {
          yield {
            contentBlockDelta: { contentBlockIndex: index, delta: { text: narrated.prose } },
          } as ConverseStreamOutput;
          yield { contentBlockStop: { contentBlockIndex: index } } as ConverseStreamOutput;
          index += 1;
        }
        converted += 1;
        yield {
          contentBlockStart: {
            contentBlockIndex: index,
            start: {
              toolUse: { toolUseId: `narrated_${converted}_${index}`, name: narrated.name },
            },
          },
        } as ConverseStreamOutput;
        yield {
          contentBlockDelta: {
            contentBlockIndex: index,
            delta: { toolUse: { input: JSON.stringify(narrated.input) } },
          },
        } as ConverseStreamOutput;
        yield { contentBlockStop: { contentBlockIndex: index } } as ConverseStreamOutput;
        index += 1;
        continue;
      }

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

  // A converted call MUST report `tool_use`, whatever the response claimed. Llama answered
  // `end_turn` while narrating a call, so honouring it finished the run with the tool never
  // dispatched — the "completed but did nothing" symptom.
  const stopReason = converted > 0 ? "tool_use" : (output.stopReason ?? "end_turn");
  yield { messageStop: { stopReason } } as ConverseStreamOutput;
  if (output.usage) {
    yield { metadata: { usage: output.usage } } as ConverseStreamOutput;
  }
}

/**
 * A tool call a model wrote as TEXT instead of using the tool protocol.
 *
 * Llama emits its native function JSON — `{"type":"function","name":"bash","parameters":{…}}` —
 * as an ordinary text block, and Bedrock does not parse it, so the run completed having executed
 * nothing and the participant read raw JSON. Recovering it is worth doing; doing it loosely is
 * not, because "execute a tool because the model printed something JSON-shaped" is a foothold.
 *
 * So the guards are strict: tools must have been OFFERED, the payload must parse, and its `name`
 * must match one of the offered tools. Prose before the call is preserved as its own text block;
 * prose AFTER it is not supported, because then the JSON is likelier to be discussion than
 * intent. Anything unmatched stays text.
 */
export function narratedToolCall(
  text: string,
  toolNames: readonly string[],
): { name: string; input: unknown; prose: string } | null {
  if (toolNames.length === 0) return null;

  const fenced = stripFence(text);
  // The call must be the TAIL of the block, so `You could use {"command":"ls"} for that` — JSON
  // mid-sentence — cannot match.
  if (fenced.trimEnd().at(-1) !== "}") return null;

  // Scan `{` positions LEFT to RIGHT and take the first that parses, which is the outermost
  // trailing object. Scanning from the right instead finds the innermost brace of a nested
  // payload (`…"parameters": {`), whose slice never parses — so nothing was ever recovered.
  let parsed: unknown = null;
  let start = -1;
  for (let i = fenced.indexOf("{"); i !== -1; i = fenced.indexOf("{", i + 1)) {
    try {
      parsed = JSON.parse(fenced.slice(i).trim());
      start = i;
      break;
    } catch {
      // Not the start of the trailing object; keep looking.
    }
  }
  if (start === -1 || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const p = parsed as Record<string, unknown>;
  const name = typeof p.name === "string" ? p.name : null;
  if (name === null || !toolNames.includes(name)) return null;

  // `parameters` is Llama's spelling, `arguments` the OpenAI-style one; both appear.
  const input = p.parameters ?? p.arguments ?? p.input ?? {};
  return { name, input, prose: fenced.slice(0, start).trim() };
}

/** Models often wrap the JSON in a markdown fence. */
function stripFence(text: string): string {
  const fence = text.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
  return fence?.[1] ?? text;
}
