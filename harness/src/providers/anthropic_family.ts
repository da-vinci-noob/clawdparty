import type { ProviderEvent, StopReason } from "./contract.js";

/**
 * Stream mapping shared by every Anthropic-family adapter (direct, host OAuth, Bedrock).
 *
 * R3's finding is what makes this possible: after construction, the first-party client and
 * the Bedrock Mantle client expose the SAME `messages.stream` surface and emit the same
 * event shapes. The differences between the three access paths are AUTHENTICATION and
 * CAPABILITIES, not the wire events — so triplicating ~80 lines of mapping would guarantee
 * the copies drift, and a drift here is a block that comes back subtly different one turn
 * later.
 *
 * IMPORTS NO VENDOR PACKAGE, which is what keeps the binding rule intact while still
 * sharing the code. Every parameter is typed STRUCTURALLY against the event shape rather
 * than against `Anthropic.RawMessageStreamEvent`: an adapter is still the only file that
 * may import its own SDK, and this file could not smuggle a vendor type across the seam
 * even by accident.
 */

/** The subset of a vendor stream event this mapping reads. Structural, deliberately. */
export interface RawStreamEvent {
  type: string;
  index?: number;
  message?: { model?: string };
  content_block?: { type?: string };
  delta?: Record<string, unknown>;
  usage?: {
    input_tokens?: number | null;
    output_tokens?: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

/** What a vendor stream must offer to be mapped: iteration plus the accumulated message. */
export interface RawStream extends AsyncIterable<RawStreamEvent> {
  currentMessage?: { content?: unknown[] } | undefined;
}

export function blockKind(type: string): "text" | "thinking" | "tool_use" | "compaction" {
  if (type === "text") return "text";
  if (type === "thinking" || type === "redacted_thinking") return "thinking";
  if (type.startsWith("compaction")) return "compaction";
  return "tool_use";
}

export function mapDelta(index: number, delta: Record<string, unknown>): ProviderEvent | null {
  switch (delta.type) {
    case "text_delta":
      return { t: "text_delta", index, text: String(delta.text ?? "") };
    case "thinking_delta":
      return { t: "thinking_delta", index, text: String(delta.thinking ?? "") };
    case "input_json_delta":
      return { t: "tool_input_delta", index, partialJson: String(delta.partial_json ?? "") };
    default:
      // signature_delta and citations_delta carry no harness-visible text; they ride along
      // inside the verbatim block delivered at block_stop.
      return null;
  }
}

/**
 * `stop_sequence` is the one SDK reason with no harness equivalent — it is a normal end of
 * turn from the loop's point of view. Everything else maps 1:1.
 */
export function mapStopReason(reason: string | null | undefined): StopReason {
  if (reason === null || reason === undefined || reason === "stop_sequence") return "end_turn";
  return reason as StopReason;
}

/**
 * One vendor stream to `ProviderEvent`s.
 *
 * `block_stop` passes the accumulated block through UNTOUCHED — the SDK assembles it, and
 * rebuilding it here would drop the compaction and thinking state the next request needs
 * (R6). An unmapped event type becomes `{ t: "raw" }` rather than throwing.
 */
export async function* mapAnthropicStream(stream: RawStream): AsyncIterable<ProviderEvent> {
  for await (const event of stream) {
    switch (event.type) {
      case "message_start":
        yield { t: "message_start", model: String(event.message?.model ?? "") };
        break;

      case "content_block_start":
        yield {
          t: "block_start",
          index: event.index ?? 0,
          kind: blockKind(String(event.content_block?.type ?? "")),
        };
        break;

      case "content_block_delta": {
        const mapped = mapDelta(event.index ?? 0, event.delta ?? {});
        if (mapped) yield mapped;
        break;
      }

      case "content_block_stop": {
        const index = event.index ?? 0;
        yield { t: "block_stop", index, block: stream.currentMessage?.content?.[index] };
        break;
      }

      case "message_delta":
        yield {
          t: "message_delta",
          stopReason: mapStopReason(event.delta?.stop_reason as string | null | undefined),
          usage: {
            input_tokens: event.usage?.input_tokens ?? 0,
            output_tokens: event.usage?.output_tokens ?? 0,
            cache_read_input_tokens: event.usage?.cache_read_input_tokens ?? 0,
            cache_creation_input_tokens: event.usage?.cache_creation_input_tokens ?? 0,
          },
        };
        break;

      case "message_stop":
        yield { t: "message_stop" };
        break;

      default:
        yield { t: "raw", value: event };
    }
  }
}

/**
 * Probe failure → a reason and an actionable remedy, shared because the HTTP contract is
 * the same on all three paths. `remedy` names the specific fix rather than "check your
 * credentials", which is the difference between a message a developer can act on and one
 * they have to interpret.
 */
export function classifyProbeFailure(
  err: unknown,
  hints: { expired: string; notEntitled: string; unreachable: string },
): {
  reason: "no_credential" | "credential_expired" | "not_entitled" | "unreachable";
  remedy: string;
} {
  const status = (err as { status?: number } | null)?.status;
  if (status === 401) return { reason: "credential_expired", remedy: hints.expired };
  if (status === 403) return { reason: "not_entitled", remedy: hints.notEntitled };
  return { reason: "unreachable", remedy: `${hints.unreachable}: ${String(err)}` };
}
