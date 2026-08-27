import type { FC } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../../hooks/use_session";

// What this session IS: its mode and the directory it works in. Visible to every role,
// because mode is not an owner setting — it is fixed at creation for the session's lifetime
// (session-run-modes) and it decides whether approve/reject can ever appear.
//
// It was invisible before: the session view never fetched the session at all, so a chat
// session looked exactly like a review session that had produced no changes. The label says
// what the mode IMPLIES rather than only naming it, because "chat" on its own is what
// nobody managed to infer "no approve/reject, ever" from.

export const SessionInfo: FC<{ sessionId: string }> = ({ sessionId }) => {
  const session = useSession(sessionId);
  if (session === null) {
    return null;
  }

  const chat = session.mode === "chat";
  return (
    <div data-testid="session-info" className="space-y-[5px]">
      <div className="flex items-center gap-[7px]">
        <span
          className="rounded-[5px] px-[6px] py-[2px] font-mono text-[10px] uppercase tracking-[1px]"
          style={
            chat
              ? { background: "#1c1a10", color: "#c9a227" }
              : { background: "#0f1c2b", color: "#3b9dff" }
          }
        >
          {session.mode}
        </span>
        <span className="text-[11px] text-[#6b726b]">
          {chat ? "no git review" : "git diff + approve/reject"}
        </span>
      </div>
      <div
        className="truncate font-mono text-[11px] text-[#7c847c]"
        title={session.repository_path ?? undefined}
      >
        {session.repository_path ?? "—"}
      </div>
      {/*  for the roles that never see the composer. A reviewer or viewer cannot start a
          run, but they can ask someone who can — so who pays has to be legible to the whole room,
          not only to the person clicking Run. */}
      <div data-testid="session-account-notice" className="text-[11px] text-[#6b726b]">
        Runs spend the host developer's account
        {session.aws_profile ? (
          <span data-testid="session-account-profile"> · AWS profile {session.aws_profile}</span>
        ) : null}
      </div>
      {/* Every role, because the settings page is readable by every role — the auth test is how a
          participant finds out WHY a provider is missing instead of asking someone else to look. */}
      <Link
        to={`/sessions/${sessionId}/settings`}
        data-testid="session-settings-link"
        className="inline-block text-[11px] text-[#3b9dff] hover:underline"
      >
        settings
      </Link>
    </div>
  );
};
