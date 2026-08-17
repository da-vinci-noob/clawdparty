import { isCompactionType } from "../context/compaction.js";
import type { FailureHints, ProviderEvent, StopReason, Usage } from "./contract.js";

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

/** The usage figures a vendor stream reports, on either of the two events that carry them. */
export interface RawUsage {
  input_tokens?: number | null;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** The subset of a vendor stream event this mapping reads. Structural, deliberately. */
export interface RawStreamEvent {
  type: string;
  index?: number;
  /** `usage` here is the OPENING count — `input_tokens` plus the cache fields. */
  message?: { model?: string; usage?: RawUsage };
  content_block?: { type?: string };
  delta?: Record<string, unknown>;
  usage?: RawUsage;
}

/** What a vendor stream must offer to be mapped: iteration plus the accumulated message. */
export interface RawStream extends AsyncIterable<RawStreamEvent> {
  currentMessage?: { content?: unknown[] } | undefined;
}

/**
 * The budget to reserve when a model takes the OLDER `thinking: {type:"enabled", budget_tokens}`
 * shape, shared by all three Anthropic paths because it is a property of the API, not of a host.
 *
 * MEASURED on Bedrock: the shape on six profiles, the floor (`512` is a 400 — "Input should be
 * greater than or equal to 1024"), and that `max_tokens` must be STRICTLY greater than the budget.
 * The magnitude is a choice inside that rule.
 */
export const DEFAULT_THINKING_BUDGET_TOKENS = 8192;

/** One raw usage object to the contract's shape; a missing figure is 0, never undefined. */
function usageFrom(usage: RawUsage | undefined): Usage {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
  };
}

export function blockKind(type: string): "text" | "thinking" | "tool_use" | "compaction" {
  if (type === "text") return "text";
  if (type === "thinking" || type === "redacted_thinking") return "thinking";
  if (isCompactionType(type)) return "compaction";
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
  /**
   * Usage accumulated ACROSS the stream, because the two events split it and models differ on how
   * (measured on Bedrock): `message_start` always carries `input_tokens` and the cache fields,
   * while `message_delta` carries the final `output_tokens` and only SOMETIMES repeats the input
   * ones. Reading the delta alone recorded `input_tokens: 0` for every model of the first kind —
   * opus-4-1 among them — and the web's context bar divides that figure by the window, so a session
   * with real history displayed as using none.
   */
  let opening: Usage | null = null;

  for await (const event of stream) {
    switch (event.type) {
      case "message_start":
        opening = usageFrom(event.message?.usage);
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

      case "message_delta": {
        const delta = usageFrom(event.usage);
        yield {
          t: "message_delta",
          stopReason: mapStopReason(event.delta?.stop_reason as string | null | undefined),
          usage: {
            // The delta wins where it reports a figure — it is the later and more complete one —
            // and `message_start` fills the fields it omits. `output_tokens` is the reverse: the
            // opening event carries the count SO FAR, so the delta's total is the one to keep.
            input_tokens: delta.input_tokens || (opening?.input_tokens ?? 0),
            output_tokens: delta.output_tokens,
            cache_read_input_tokens:
              delta.cache_read_input_tokens || (opening?.cache_read_input_tokens ?? 0),
            cache_creation_input_tokens:
              delta.cache_creation_input_tokens || (opening?.cache_creation_input_tokens ?? 0),
          },
        };
        break;
      }

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
  hints: { expired: string; notEntitled: string; unreachable: string; noCredential?: string },
): {
  reason: "no_credential" | "credential_expired" | "not_entitled" | "unreachable";
  remedy: string;
} {
  const status = (err as { status?: number } | null)?.status;
  if (status === 401) return { reason: "credential_expired", remedy: hints.expired };
  if (status === 403) return { reason: "not_entitled", remedy: hints.notEntitled };
  // No status means the SDK threw BEFORE sending anything, and its own auth-resolution failure is
  // the case that matters: nothing was sent, so calling it `unreachable` told the developer to
  // check a network that was never used. `no_credential` was in the union all along with no code
  // path producing it — the same defect already fixed for Bedrock.
  if (status === undefined && isAuthResolutionFailure(err)) {
    return {
      reason: "no_credential",
      remedy: hints.noCredential ?? `No credential was sent: ${String(err)}`,
    };
  }
  return { reason: "unreachable", remedy: `${hints.unreachable}: ${String(err)}` };
}

function isAuthResolutionFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /could not resolve authentication method|expected one of apiKey/i.test(message);
}

/**
 * A provider failure always names a remedy — a generic message violates.
 *
 * The STATUS is classified here (it is HTTP, not vendor-specific) and the WORDS come from the
 * adapter, which is the only thing that knows which credential it consumes. Without that split
 * every provider got the same remedy, so an expired AWS SSO session was answered with
 * `claude setup-token` — advice that fixes nothing.
 *
 * The fallbacks are deliberately vendor-NEUTRAL. An adapter that declares no hints should produce
 * vague advice, never advice for somebody else's credential.
 */
export function classifyStreamError(
  err: unknown,
  hints?: FailureHints,
): { kind: string; message: string; remedy: string } {
  const status = (err as { status?: number } | null)?.status;
  if (status === 401) {
    return {
      kind: "credential_expired",
      message: "the provider rejected the credential (401)",
      remedy: hints?.expired ?? "Refresh this provider's credential and start a new run.",
    };
  }
  if (status === 403) {
    return {
      kind: "not_entitled",
      message: "the provider refused the request as unentitled (403)",
      // NOT a re-authentication prompt: the credential is valid, so logging in again changes
      // nothing. Telling someone to re-auth here sends them in a circle.
      remedy:
        hints?.notEntitled ??
        "This credential is valid but not permitted to use this model. Check its access, or pick a model it can serve.",
    };
  }
  if (status === 429) {
    return {
      kind: "api_error",
      message: "rate limited (429)",
      remedy: "Wait and retry; reduce concurrent runs if this persists.",
    };
  }
  return {
    kind: "api_error",
    message: String(err),
    remedy: hints?.unreachable ?? "Check network access to the provider and retry the run.",
  };
}
