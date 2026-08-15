import type { StopReason } from "../providers/contract.js";

/**
 * What the loop does about each of the six stop reasons.
 *
 * All six are handled explicitly and the mapping is total, because the two most
 * consequential ones are SILENT when mishandled:
 *
 *   - `pause_turn` means a server-side tool hit its iteration limit. Treating it
 *     as terminal truncates the turn with no error anywhere.
 *   - `refusal` arrives as **HTTP 200**, possibly with empty or partial content.
 *     Code that indexes `content[0]` unconditionally breaks on it, so it must be
 *     checked BEFORE content is read.
 *
 * `model_context_window_exceeded` is deliberately NOT folded into `max_tokens`:
 * one means "the answer was cut off", the other means "the conversation no longer
 * fits". The first is surfaced, the second triggers compaction.
 */

export type LoopAction =
  /** Nothing owed; settle the run. */
  | { kind: "settle"; outcome: "finished"; stopReason: StopReason }
  /** Dispatch the turn's tool calls, then continue. */
  | { kind: "dispatch_tools" }
  /** Re-send the assistant turn to let a server-side tool continue. */
  | { kind: "resume"; attempt: number; maxAttempts: number }
  /** Summarize and retry the same turn. */
  | { kind: "compact" }
  /** Settle, but as a failure the participant needs to see. */
  | { kind: "settle_failed"; stopReason: StopReason; message: string };

/**
 * A `pause_turn` loop is possible if the server-side tool never converges, so
 * resumes are capped. Chosen over an unbounded retry because the failure mode of
 * "too few resumes" is a visibly truncated answer, while "unbounded" is a run that
 * silently bills forever.
 */
export const MAX_PAUSE_RESUMES = 5;

export function decide(reason: StopReason, resumeAttempt = 0): LoopAction {
  switch (reason) {
    case "end_turn":
      return { kind: "settle", outcome: "finished", stopReason: reason };

    case "tool_use":
      return { kind: "dispatch_tools" };

    case "max_tokens":
      // Surfaced rather than silently continued: the answer really is cut off,
      // and quietly asking for more would hide that from the participant.
      return {
        kind: "settle_failed",
        stopReason: reason,
        message:
          "The response hit its output limit and is incomplete. Ask for the rest, or " +
          "narrow the request.",
      };

    case "pause_turn":
      if (resumeAttempt >= MAX_PAUSE_RESUMES) {
        return {
          kind: "settle_failed",
          stopReason: reason,
          message: `A server-side tool did not finish after ${MAX_PAUSE_RESUMES} resumes.`,
        };
      }
      return { kind: "resume", attempt: resumeAttempt + 1, maxAttempts: MAX_PAUSE_RESUMES };

    case "refusal":
      return {
        kind: "settle_failed",
        stopReason: reason,
        message: "The model declined to continue this request.",
      };

    case "model_context_window_exceeded":
      return { kind: "compact" };
  }
}

/**
 * True when the response's `content` must NOT be read as though it were a normal
 * answer. `refusal` is the case that matters: HTTP 200 with content that may be
 * empty or partial.
 */
export function contentIsUntrustworthy(reason: StopReason): boolean {
  return reason === "refusal";
}

/** Whether a reason ends the run rather than continuing the loop. */
export function isTerminal(reason: StopReason): boolean {
  const action = decide(reason);
  return action.kind === "settle" || action.kind === "settle_failed";
}
