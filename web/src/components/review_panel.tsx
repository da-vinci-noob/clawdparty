import { type FC, useMemo } from "react";
import { useSession } from "../hooks/use_session";
import {
  selectAwaitingReviewRunId,
  selectChangedPaths,
  useEventStore,
} from "../stores/event_store";
import { DiffView } from "./diff_view";

// The review slot, gated on the session's MODE rather than on whether a changeset event
// happens to have arrived.
//
// Both produce the same outcome for a chat session — it never enters `awaiting_review`, so
// no changeset exists — but changeset-presence alone makes a chat session render exactly
// like a review session that produced nothing: an empty space where the diff would be. A
// participant who had just watched Claude edit files read that as a broken approve flow.
// `session-run-modes` asks the web to omit the affordances for chat; it does not ask it to
// leave the participant guessing why.

export const ReviewPanel: FC<{ sessionId: string }> = ({ sessionId }) => {
  const session = useSession(sessionId);
  const reviewRunId = useEventStore(selectAwaitingReviewRunId);
  // Subscribe to the STABLE durable array and derive here: `selectChangedPaths` builds a
  // new array per call, so subscribing to it directly would re-render forever.
  const durable = useEventStore((s) => s.durableList);
  const changedPaths = useMemo(() => selectChangedPaths({ durableList: durable }), [durable]);

  // Unknown mode renders nothing: defaulting to review would flash a diff panel at a chat
  // session, and defaulting to chat would hide a real approve button.
  if (session === null) {
    return null;
  }

  if (session.mode === "chat") {
    return <ChatModeNotice paths={changedPaths} workingDirectory={session.repository_path} />;
  }

  if (reviewRunId === null) {
    return null;
  }

  return (
    <div className="cp-diff-in mb-4 rounded-[13px] border border-[#1d3652] bg-[#0c0e0c] p-[18px] shadow-[0_18px_40px_-12px_rgba(0,0,0,.7)]">
      <DiffView runId={reviewRunId} />
    </div>
  );
};

// Silent until edits exist: for a question-and-answer session there is nothing to explain.
const ChatModeNotice: FC<{ paths: string[]; workingDirectory: string | null }> = ({
  paths,
  workingDirectory,
}) => {
  if (paths.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="chat-mode-notice"
      className="mb-4 rounded-[13px] border border-[#2a2f22] bg-[#0c0e0c] p-[18px]"
    >
      <p className="text-[13px] text-[#cdd2cd]">
        <span className="font-mono text-[11px] uppercase tracking-[1px] text-[#c9a227]">
          chat mode
        </span>{" "}
        — edits are applied directly to{" "}
        <span className="font-mono text-[12px] text-[#cdd2cd]">
          {workingDirectory ?? "the working directory"}
        </span>
        . There is no worktree and nothing to approve or reject; commit or discard these with git
        yourself.
      </p>
      <ul className="mt-[10px] space-y-[3px]">
        {paths.map((path) => (
          <li
            key={path}
            data-testid="chat-changed-path"
            className="truncate font-mono text-[12px] text-[#9aa39a]"
          >
            {relativeTo(path, workingDirectory)}
          </li>
        ))}
      </ul>
    </div>
  );
};

// `file_changed` carries the ABSOLUTE host path, which is long enough to bury the part that
// identifies the file. Falls back to the full path when it is not under the directory.
function relativeTo(path: string, workingDirectory: string | null): string {
  if (workingDirectory === null || !path.startsWith(`${workingDirectory}/`)) {
    return path;
  }
  return path.slice(workingDirectory.length + 1);
}
