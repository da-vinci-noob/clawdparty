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

export const RunBanner: FC<{ event: EventEnvelope; names: ParticipantNames }> = ({
  event,
  names,
}) => {
  const label = LABELS[event.type] ?? event.type;
  const who = event.actor.kind === "user" ? `${actorLabel(event.actor, names)} ` : "";
  const answerOnly = isAnswerOnly(event);
  return (
    <div
      data-testid="feed-run-banner"
      className="flex items-center gap-2 text-[11px] text-[#6b726b]"
    >
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
      </span>
    </div>
  );
};
