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
  participant_joined: "joined the session",
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
  const started =
    event.type === "run_started"
      ? (event.payload as {
          permission_mode?: string;
          disallowed_tools?: string[];
          connectors?: string[];
          skills?: string[];
        })
      : undefined;
  const mode = started?.permission_mode;
  // Compact echo of the capabilities the run actually applied (additive optional
  // run_started fields; absent parts are omitted).
  const capParts: string[] = [];
  if (started?.disallowed_tools?.length) {
    capParts.push(`tools −${started.disallowed_tools.join(", ")}`);
  }
  if (started?.connectors?.length) {
    capParts.push(`connectors: ${started.connectors.join(", ")}`);
  }
  if (started?.skills?.length) {
    capParts.push(`skills: ${started.skills.join(", ")}`);
  }
  const caps = capParts.join(" · ");
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
        {mode && (
          <span
            data-testid="run-mode"
            className="ml-1 rounded-[5px] border border-[#1c2a20] bg-[#0e140f] px-1 text-[10px] uppercase text-[#7c847c]"
          >
            {MODE_LABELS[mode] ?? mode}
          </span>
        )}
        {caps && (
          <span
            data-testid="run-caps"
            className="ml-1 rounded-[5px] border border-[#1c2a20] bg-[#0e140f] px-1 text-[10px] text-[#7c847c]"
          >
            {caps}
          </span>
        )}
      </span>
    </div>
  );
};
