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
      className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900/50 px-2 py-1 text-xs text-neutral-400"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500" aria-hidden="true" />
      <span>
        {who}
        {label}
        {mode && (
          <span
            data-testid="run-mode"
            className="ml-1 rounded bg-neutral-800 px-1 text-[10px] uppercase"
          >
            {MODE_LABELS[mode] ?? mode}
          </span>
        )}
      </span>
    </div>
  );
};
