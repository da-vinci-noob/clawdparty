import type { FC } from "react";
import { Link } from "react-router-dom";
import { type SessionSummary, useArchiveSession, useSessions } from "../../hooks/use_sessions";

// The caller's sessions, grouped into "Your sessions" (hosted) and "Joined", each
// row badged only active/revoked (revoked == the archived hard-close status). An
// owner gets an "end session" control on their active rows; the server enforces
// the owner gate, this only hides the button. Used by the sessions page and the
// session workspace's left rail.
export const SessionList: FC = () => {
  const sessions = useSessions();
  const archive = useArchiveSession();

  const owned = sessions.filter((s) => s.owned);
  const joined = sessions.filter((s) => !s.owned);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-[10px] pb-4 pt-2" data-testid="session-list">
      <SessionGroup label="Your sessions" sessions={owned} onArchive={archive} />
      <SessionGroup label="Joined" sessions={joined} onArchive={archive} />
      {sessions.length === 0 && (
        <p className="px-[6px] pt-3 font-mono text-[11px] text-[#6b726b]">No sessions yet.</p>
      )}
    </div>
  );
};

interface GroupProps {
  label: string;
  sessions: SessionSummary[];
  onArchive: (id: string) => void;
}

const SessionGroup: FC<GroupProps> = ({ label, sessions, onArchive }) => {
  if (sessions.length === 0) {
    return null;
  }
  return (
    <>
      <div className="flex items-center justify-between px-[6px] pb-[6px] pt-[10px]">
        <span className="font-mono text-[10px] uppercase tracking-[1px] text-[#6b726b]">
          {label}
        </span>
        <span className="font-mono text-[10px] text-[#3a4440]">{sessions.length}</span>
      </div>
      {sessions.map((session) => (
        <SessionRow key={session.id} session={session} onArchive={onArchive} />
      ))}
    </>
  );
};

interface RowProps {
  session: SessionSummary;
  onArchive: (id: string) => void;
}

const SessionRow: FC<RowProps> = ({ session, onArchive }) => {
  const revoked = session.status === "archived";
  const canEnd = session.my_role === "owner" && !revoked;
  return (
    <div className="group rounded-[9px] transition hover:bg-[#0e140f]" data-testid="session-row">
      <Link
        to={`/sessions/${session.id}`}
        className="block px-[11px] py-[9px] text-left"
        style={{ color: "inherit", textDecoration: "none" }}
      >
        <div className="flex min-w-0 items-center gap-[9px]">
          <span
            className="h-[7px] w-[7px] flex-none rounded-full"
            style={
              revoked
                ? { background: "#3a4440" }
                : { background: "#3b9dff", boxShadow: "0 0 8px rgba(59,157,255,.85)" }
            }
          />
          <span className="truncate font-mono text-[13px] font-medium">{session.title}</span>
        </div>
        <div className="mt-[6px] flex items-center justify-between pl-[17px]">
          <span className="text-[11px] text-[#6b726b]">
            {relativeActivity(session.last_activity_at ?? session.created_at)}
          </span>
          <StatusBadge revoked={revoked} />
        </div>
      </Link>
      {canEnd && (
        <div className="px-[11px] pb-[9px] pl-[28px]">
          <button
            type="button"
            onClick={() => onArchive(session.id)}
            className="font-mono text-[10px] uppercase tracking-[0.4px] text-[#7c847c] transition hover:text-[#d68484]"
          >
            end session
          </button>
        </div>
      )}
    </div>
  );
};

const StatusBadge: FC<{ revoked: boolean }> = ({ revoked }) => (
  <span
    data-testid="status-badge"
    className="rounded-full px-[7px] py-px font-mono text-[9px] uppercase tracking-[0.4px]"
    style={
      revoked
        ? { background: "#241717", color: "#d68484" }
        : { background: "#0a1826", color: "#3b9dff" }
    }
  >
    {revoked ? "revoked" : "active"}
  </span>
);

// Coarse relative label from an ISO timestamp — no dependency, good enough for a
// "last active" hint. Falls back to the raw date for anything older than a week.
function relativeActivity(iso: string): string {
  const then = new Date(iso).getTime();
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "active just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `active ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `active ${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `active ${days}d ago`;
  return `active ${new Date(iso).toLocaleDateString()}`;
}
