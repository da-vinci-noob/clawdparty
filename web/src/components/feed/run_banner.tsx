import { BUILTIN_TOOL_IDS, type EventEnvelope } from "@clawdparty/contracts";
import type { FC } from "react";
import { type ParticipantNames, actorLabel } from "../../helpers/participant_names";

// Run-lifecycle banner. Human events (run_started/run_interrupted) are attributed
// to the acting participant (resolved from actor.id); system events
// (run_finished/run_failed) render as system framing.
const LABELS: Record<string, string> = {
  run_started: "started the run",
  run_finished: "run finished",
  run_failed: "run failed",
  run_interrupted: "interrupted the run",
  changeset_ready: "changeset ready for review",
  changeset_approved: "approved the changes",
  changeset_rejected: "rejected the changes",
  participant_joined: "joined the session",
};

/**
 * A capability change, in a sentence.
 *
 * `skill_changed` is session-scoped and not part of a run, but it belongs in the timeline for the
 * same reason a run does: a skill is instructions Claude will follow, so WHO changed what the room
 * can do is exactly what a reader needs. A removal says "moved aside" because that is what happened
 * — the directory is renamed, not deleted.
 */
function skillSentence(payload: {
  action?: string;
  name?: string;
  scope?: string;
  moved_to?: string;
}): string {
  const where = payload.scope === "host" ? "host-wide" : "this repo";
  if (payload.action === "removed") {
    return `moved the ${where} skill ${payload.name} aside`;
  }
  const verb = payload.action === "replaced" ? "replaced" : "added";
  return `${verb} the ${where} skill ${payload.name}`;
}

// Whether a run_started's RESOLVED scope withheld every built-in tool — the shape a run gets on
// a model that cannot use tools. Read from the event, so a late joiner arriving by
// backfill learns it too: otherwise a run that can only answer is indistinguishable from one
// that chose not to act.
function isAnswerOnly(event: EventEnvelope): boolean {
  if (event.type !== "run_started") {
    return false;
  }
  const disallowed = (event.payload as { disallowed_tools?: unknown }).disallowed_tools;
  if (!Array.isArray(disallowed)) {
    return false;
  }
  return BUILTIN_TOOL_IDS.every((tool) => disallowed.includes(tool));
}

/**
 * Connectors the run enabled but could not load.
 *
 * Read from the event so a late joiner learns it too. Without this the participant who enabled a
 * connector sees no tools from it and no reason — and the reason is knowable: the harness
 * classified it (`not_configured` / `timeout` / `failed`) at run start.
 */
function failedConnectors(event: EventEnvelope): Array<{ name: string; kind: string }> {
  if (event.type !== "run_started") {
    return [];
  }
  const failed = (event.payload as { connectors_failed?: unknown }).connectors_failed;
  return Array.isArray(failed) ? (failed as Array<{ name: string; kind: string }>) : [];
}

const FAILURE_TEXT: Record<string, string> = {
  not_configured: "not configured on the host",
  timeout: "did not respond",
  failed: "failed to connect",
};

/**
 * Why the run failed, in the harness's own words (contract 1.12).
 *
 * The loop has composed these sentences since M4 — an output limit, a server-side tool that
 * never converged, a refusal — and `RunLoop.fail()` took the argument as `_message` and threw it
 * away, so the room read "run failed" and stopped there. On a provider that returns no
 * explanation with a refusal this is the only account of it that exists.
 */
function failureExplanation(event: EventEnvelope): string | null {
  if (event.type !== "run_failed") {
    return null;
  }
  const explanation = (event.payload as { explanation?: unknown }).explanation;
  return typeof explanation === "string" && explanation.length > 0 ? explanation : null;
}

export const RunBanner: FC<{ event: EventEnvelope; names: ParticipantNames }> = ({
  event,
  names,
}) => {
  const label =
    event.type === "skill_changed"
      ? skillSentence(event.payload as Parameters<typeof skillSentence>[0])
      : (LABELS[event.type] ?? event.type);
  const who = event.actor.kind === "user" ? `${actorLabel(event.actor, names)} ` : "";
  const answerOnly = isAnswerOnly(event);
  const failed = failedConnectors(event);
  const explanation = failureExplanation(event);
  return (
    <div data-testid="feed-run-banner" className="flex flex-col gap-1 text-[11px] text-[#6b726b]">
      <div className="flex items-center gap-2">
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#3b9dff]"
          style={{ boxShadow: "0 0 6px rgba(59,157,255,.7)" }}
          aria-hidden="true"
        />
        <span>
          {who && <span className="text-[#aeb4ae]">{who}</span>}
          {label}
          {answerOnly && (
            <span data-testid="run-answer-only" className="text-[#565d58]">
              {" "}
              · no tools, answers only
            </span>
          )}
          {failed.map((connector) => (
            <span
              key={connector.name}
              data-testid={`run-connector-failed-${connector.name}`}
              className="text-[#c9a227]"
            >
              {" "}
              · {connector.name} {FAILURE_TEXT[connector.kind] ?? "unavailable"}
            </span>
          ))}
        </span>
      </div>
      {/* Its own line rather than appended to the banner: these are full sentences with an
          action in them, and squeezing one onto a "run failed ·" line is how it gets ignored. */}
      {explanation && (
        <p data-testid="run-failed-explanation" className="pl-[14px] text-[#a89a7a]">
          {explanation}
        </p>
      )}
    </div>
  );
};
