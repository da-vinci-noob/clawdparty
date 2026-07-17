import type { EventEnvelope } from "@clawdparty/contracts";
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
};

// Human-readable label for a permission mode on the run_started banner.
const MODE_LABELS: Record<string, string> = {
  plan: "plan mode",
  acceptEdits: "auto-accept",
  bypassPermissions: "bypass",
};

export const RunBanner: FC<{ event: EventEnvelope; names: ParticipantNames }> = ({
  event,
  names,
}) => {
  const label = LABELS[event.type] ?? event.type;
  const who = event.actor.kind === "user" ? `${actorLabel(event.actor, names)} ` : "";
  const mode =
    event.type === "run_started"
      ? (event.payload as { permission_mode?: string }).permission_mode
      : undefined;
  return (
    <div
      data-testid="feed-run-banner"
      className="flex items-center gap-2 text-[11px] text-[#565d58]"
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#4fe89a]"
        style={{ boxShadow: "0 0 6px rgba(79,232,154,.7)" }}
        aria-hidden="true"
      />
      <span>
        {who && <span className="text-[#9aa39c]">{who}</span>}
        {label}
        {mode && (
          <span
            data-testid="run-mode"
            className="ml-1 rounded-[5px] border border-[#2a352d] bg-[#141a16] px-1 text-[10px] uppercase text-[#79817b]"
          >
            {MODE_LABELS[mode] ?? mode}
          </span>
        )}
      </span>
    </div>
  );
};
