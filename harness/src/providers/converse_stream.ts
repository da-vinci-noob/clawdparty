import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import type { ProviderEvent, StopReason, Usage } from "./contract.js";

/**
 * Bedrock `ConverseStream` → `ProviderEvent`.
 *
 * A separate module from `anthropic_family.ts` on purpose. Converse speaks a different
 * vocabulary — `messageStart` / `contentBlockStart` / `contentBlockDelta` / `contentBlockStop`
 * / `messageStop` / `metadata` — and sharing the Anthropic mapper would mean one file
 * claiming to understand two protocols. Everything here was written against captured bytes
 * (`test/fixtures/converse/`), because the first attempt to describe this protocol from
 * documentation got it wrong twice.
 *
 * Three things about Converse that a mapper written from Anthropic habits gets wrong, all of
 * them silent:
 *
 *  1. **Text blocks send NO `contentBlockStart`.** Only `toolUse` announces itself. Opening a
 *     block on `contentBlockStart` therefore drops every text delta and yields empty
 *     assistant turns. This mapper SYNTHESIZES `block_start` on the first delta of an unseen
 *     index, because the loop's normalizer needs the open/close pairing.
 *  2. **Tool input arrives as partial-JSON string fragments**, not a parsed object. The first
 *     fragment alone (`{"`) throws on `JSON.parse`. Passed through as `tool_input_delta`, as
 *     the Anthropic path does with `input_json_delta`.
 *  3. **Usage arrives at the END**, on `metadata`, with Converse's own field names and NO
 *     cache fields. `message_delta` carries the usage in the ProviderEvent contract, so the
 *     `messageStop` stop reason is held until `metadata` lands and the two are emitted
 *     together — one `message_delta` then one `message_stop`, matching the Anthropic shape the
 *     loop already consumes.
 */

/** Bedrock's stop reasons, mapped to the six the loop decides on. */
const STOP_REASONS: Record<string, StopReason> = {
  end_turn: "end_turn",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  stop_sequence: "end_turn",
  guardrail_intervened: "refusal",
  content_filtered: "refusal",
};

const ZERO_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

interface OpenBlock {
  kind: "text" | "thinking" | "tool_use";
  /** Accumulated so `block_stop` can carry the VERBATIM block the surface echoes back. */
  text: string;
  partialJson: string;
  toolUseId?: string;
  name?: string;
  /** Encrypted reasoning bytes, kept as-is: they are the provider's carrier for reasoning
   *  state across turns and must never be rendered. */
  redacted?: Uint8Array;
}

/**
 * Map one Converse stream to ProviderEvents.
 *
 * `model` is passed in because Converse's `messageStart` carries only the role — there is no
 * model id anywhere in the stream, and `message_start` in the contract requires one.
 */
export async function* mapConverseStream(
  stream: AsyncIterable<ConverseStreamOutput>,
  model: string,
): AsyncGenerator<ProviderEvent> {
  const open = new Map<number, OpenBlock>();
  let stopReason: StopReason = "end_turn";
  let sawStop = false;

  for await (const event of stream) {
    if ("messageStart" in event) {
      yield { t: "message_start", model };
      continue;
    }

    if ("contentBlockStart" in event) {
      const index = event.contentBlockStart?.contentBlockIndex ?? 0;
      const toolUse = event.contentBlockStart?.start?.toolUse;
      if (toolUse) {
        open.set(index, {
          kind: "tool_use",
          text: "",
          partialJson: "",
          ...(toolUse.toolUseId ? { toolUseId: toolUse.toolUseId } : {}),
          ...(toolUse.name ? { name: toolUse.name } : {}),
        });
        yield { t: "block_start", index, kind: "tool_use" };
        continue;
      }
      // A start we do not recognise: surface it rather than guessing.
      yield { t: "raw", value: event };
      continue;
    }

    if ("contentBlockDelta" in event) {
      const index = event.contentBlockDelta?.contentBlockIndex ?? 0;
      const delta = event.contentBlockDelta?.delta;
      if (!delta) {
        yield { t: "raw", value: event };
        continue;
      }

      if (typeof delta.text === "string") {
        // Synthesize the opening the protocol never sends (hazard 1).
        if (!open.has(index)) {
          open.set(index, { kind: "text", text: "", partialJson: "" });
          yield { t: "block_start", index, kind: "text" };
        }
        const block = open.get(index) as OpenBlock;
        block.text += delta.text;
        yield { t: "text_delta", index, text: delta.text };
        continue;
      }

      if (delta.toolUse?.input !== undefined) {
        // The block was opened by contentBlockStart; if it was not, the stream is malformed
        // and a synthesized text block would silently swallow a tool call.
        if (!open.has(index)) {
          yield { t: "raw", value: event };
          continue;
        }
        const block = open.get(index) as OpenBlock;
        block.partialJson += delta.toolUse.input;
        yield { t: "tool_input_delta", index, partialJson: delta.toolUse.input };
        continue;
      }

      if (delta.reasoningContent) {
        if (!open.has(index)) {
          open.set(index, { kind: "thinking", text: "", partialJson: "" });
          yield { t: "block_start", index, kind: "thinking" };
        }
        const block = open.get(index) as OpenBlock;
        const reasoning = delta.reasoningContent;
        if (typeof reasoning.text === "string") {
          block.text += reasoning.text;
          yield { t: "thinking_delta", index, text: reasoning.text };
          continue;
        }
        if (reasoning.redactedContent) {
          // Encrypted: accumulate for the verbatim block, emit NO delta. There is nothing
          // displayable here, and emitting bytes as thinking text would print binary at a
          // participant.
          block.redacted = concat(block.redacted, reasoning.redactedContent);
          continue;
        }
        yield { t: "raw", value: event };
        continue;
      }

      yield { t: "raw", value: event };
      continue;
    }

    if ("contentBlockStop" in event) {
      const index = event.contentBlockStop?.contentBlockIndex ?? 0;
      const block = open.get(index);
      if (!block) {
        yield { t: "raw", value: event };
        continue;
      }
      open.delete(index);
      yield { t: "block_stop", index, block: verbatim(block) };
      continue;
    }

    if ("messageStop" in event) {
      // Held, not emitted: `message_delta` carries stopReason AND usage together, and usage
      // has not arrived yet (hazard 3).
      stopReason = STOP_REASONS[event.messageStop?.stopReason ?? ""] ?? "end_turn";
      sawStop = true;
      continue;
    }

    if ("metadata" in event) {
      yield { t: "message_delta", stopReason, usage: usageFrom(event.metadata?.usage) };
      yield { t: "message_stop" };
      sawStop = false;
      continue;
    }

    // internalServerException, modelStreamErrorException, throttlingException, and anything
    // added later. The adapter classifies errors; the mapper must not swallow them.
    yield { t: "raw", value: event };
  }

  // A stream that stopped without metadata still has to settle, or the loop waits for a
  // message_delta that will never come.
  if (sawStop) {
    yield { t: "message_delta", stopReason, usage: ZERO_USAGE };
    yield { t: "message_stop" };
  }
}

/**
 * The block that reaches the surface at `block_stop`.
 *
 * A tool_use block is normalized to the CANONICAL shape `{type:"tool_use", id, name, input}` —
 * NOT Converse's `{toolUse:{…}}`. That is the one shape `run_loop.streamTurn` reads a tool call
 * out of (it checks `block.type === "tool_use"` and reads `id`/`name`/`input`), and the loop is
 * provider-neutral by design, so normalizing Converse's shape to it belongs HERE, in the
 * provider's own mapper. A `{toolUse:{…}}` block left the loop with an empty tool id and the
 * follow-up turn's tool_result matched no call — "No tool output found for function call …".
 * `converse_request.ts` translates this canonical shape back to Converse `{toolUse}` on echo,
 * and the id round-trips so the pairing holds.
 *
 * text and reasoning blocks stay in Converse's own shape — the loop reads nothing structural
 * from them, and `converse_request` passes them straight through. Tool input is parsed here and
 * only here: the delta fragments form valid JSON only once concatenated.
 */
function verbatim(block: OpenBlock): unknown {
  if (block.kind === "tool_use") {
    return {
      type: "tool_use",
      id: block.toolUseId,
      name: block.name,
      input: parseOrRaw(block.partialJson),
    };
  }
  if (block.kind === "thinking") {
    return {
      reasoningContent: block.redacted
        ? // Tagged base64, NOT the raw Uint8Array. The surface is stored as JSON, and
          // `JSON.stringify` turns a Uint8Array into `{"0":114,…}` — 8KB per turn for a 900-byte
          // block, and a shape nothing can decode, so the bytes were silently unusable. These
          // bytes ARE echoed back (measured: Bedrock accepts them, and the turn then reuses the
          // reasoning instead of re-deriving it), which requires them to survive storage.
          { redactedContent: { __bytes_b64: Buffer.from(block.redacted).toString("base64") } }
        : { reasoningText: { text: block.text } },
    };
  }
  return { text: block.text };
}

/** A model can emit malformed JSON. Keeping the raw string beats throwing mid-stream: the
 *  tool call then fails with a readable error instead of killing the run. */
function parseOrRaw(partialJson: string): unknown {
  if (partialJson === "") return {};
  try {
    return JSON.parse(partialJson);
  } catch {
    return { __unparsed: partialJson };
  }
}

function usageFrom(usage: { inputTokens?: number; outputTokens?: number } | undefined): Usage {
  return {
    input_tokens: usage?.inputTokens ?? 0,
    output_tokens: usage?.outputTokens ?? 0,
    // Converse reports NO cache fields — measured across every captured scenario. Zeros here
    // are the honest answer for a provider that does not report them; `promptCaching` is
    // declared false so nothing reads them as a saving.
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

function concat(left: Uint8Array | undefined, right: Uint8Array): Uint8Array {
  if (!left) return right;
  const out = new Uint8Array(left.length + right.length);
  out.set(left);
  out.set(right, left.length);
  return out;
}
