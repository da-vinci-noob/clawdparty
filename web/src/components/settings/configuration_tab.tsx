import type { FC } from "react";
import { useCurrentParticipant } from "../../hooks/use_current_participant";
import { useSession } from "../../hooks/use_session";

// Settings → Configuration: what THIS SESSION is, and which of it can change.
//
// Read-only for every role, because none of it is secret and all of it is load-bearing: `mode`
// decides whether approve/reject can ever appear, and the working directory decides what Claude can
// see. A viewer who cannot see the mode cannot tell a chat session from a review session with no
// changes yet — the confusion this tab exists to prevent.
//
// Mode is IMMUTABLE by design (fixed for the session's lifetime), so it is shown with the reason
// rather than as a disabled control that looks like a bug. Whether to open that up is a separate
// question, not this tab's.

const rows = (session: { id: string; mode: string; repository_path: string | null }) => [
  { label: "Session id", value: session.id, scope: "this session" },
  {
    label: "Mode",
    value: session.mode === "chat" ? "chat — no git review" : "review — git diff + approve/reject",
    scope: "this session · fixed at creation",
  },
  { label: "Working directory", value: session.repository_path ?? "—", scope: "this session" },
];

export const ConfigurationTab: FC<{ sessionId: string }> = ({ sessionId }) => {
  const session = useSession(sessionId);
  const { can } = useCurrentParticipant();

  if (session === null) {
    return (
      <p data-testid="configuration-unavailable" className="text-[12px] text-[#6b726b]">
        This session’s configuration could not be read.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <dl className="space-y-2">
        {rows(session).map((row) => (
          <div
            key={row.label}
            data-testid={`config-${row.label.toLowerCase().replace(/\s+/g, "-")}`}
            className="rounded-[10px] border border-[#17231b] bg-[#0c0e0c] px-3 py-[10px]"
          >
            <dt className="text-[11px] uppercase tracking-[0.5px] text-[#565d58]">{row.label}</dt>
            <dd className="mt-[3px] break-all font-mono text-[13px] text-[#e6e8e6]">{row.value}</dd>
            {/* Every row says WHOSE setting it is. A settings page that mixes session-scoped and
                host-wide values without saying which is which produces "I changed it and the other
                session didn't". */}
            <dd className="mt-[2px] text-[11px] text-[#6b726b]">{row.scope}</dd>
          </div>
        ))}
      </dl>

      {!can("manage_session") && (
        <p data-testid="config-read-only" className="text-[11px] text-[#6b726b]">
          You can see this session’s configuration; changing it is the owner’s.
        </p>
      )}
    </div>
  );
};
