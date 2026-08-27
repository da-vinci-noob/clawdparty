import { type FC, type FormEvent, useState } from "react";
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

const rows = (session: {
  id: string;
  mode: string;
  status?: string;
  repository_path: string | null;
}) => [
  { label: "Session id", value: session.id, scope: "this session" },
  {
    label: "Mode",
    value: session.mode === "chat" ? "chat — no git review" : "review — git diff + approve/reject",
    scope: "this session · fixed at creation",
  },
  { label: "Status", value: session.status ?? "active", scope: "this session" },
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

      {can("manage_session") ? (
        <SessionTitleForm sessionId={sessionId} title={session.title ?? ""} />
      ) : (
        <p data-testid="config-read-only" className="text-[11px] text-[#6b726b]">
          You can see this session’s configuration; changing it is the owner’s.
        </p>
      )}

      {can("manage_session") && session.status !== "archived" && (
        <ArchiveSession sessionId={sessionId} />
      )}
    </div>
  );
};

// Renaming is the one Configuration field that CAN change (mode cannot, and the directory has its own
// picker in the session sidebar). A blank title is refused server-side, because the history list
// renders it and an untitled row is unidentifiable.
const SessionTitleForm: FC<{ sessionId: string; title: string }> = ({ sessionId, title }) => {
  const [value, setValue] = useState(title);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setState("saving");
    const res = await fetch(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      credentials: "include",
      // Title ONLY. Sending `repository_path` here would make the endpoint recompute the working
      // directory, which defaults to the repo root — a rename would silently move the session.
      body: JSON.stringify({ title: value.trim() }),
    }).catch(() => null);
    setState(res?.ok ? "saved" : "error");
  };

  return (
    <form onSubmit={submit} data-testid="config-title-form" className="space-y-2">
      <label className="block space-y-1">
        <span className="text-[11px] uppercase tracking-[0.5px] text-[#565d58]">Title</span>
        <input
          aria-label="Session title"
          data-testid="config-title"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full rounded-[9px] border border-[#17231b] bg-[#0e140f] px-[11px] py-[7px] font-mono text-[12px] text-[#e6e8e6]"
        />
      </label>
      <button
        type="submit"
        data-testid="config-title-save"
        disabled={state === "saving" || value.trim() === ""}
        className="rounded-[9px] bg-[#3b9dff] px-[13px] py-[7px] font-mono text-[12px] font-semibold text-[#04101f] disabled:opacity-50"
      >
        {state === "saving" ? "Saving…" : "Rename"}
      </button>
      {state === "saved" && (
        <p data-testid="config-title-saved" className="text-[12px] text-[#7cd992]">
          Renamed.
        </p>
      )}
      {state === "error" && (
        <p data-testid="config-title-error" className="text-[12px] text-[#f0a8a8]">
          Could not rename this session.
        </p>
      )}
    </form>
  );
};

// Archive is TERMINAL — no run can start on an archived session — so it asks first. Not a browser
// `confirm()`: this is a shared room, and the sentence should say what happens to everyone in it.
const ArchiveSession: FC<{ sessionId: string }> = ({ sessionId }) => {
  const [asked, setAsked] = useState(false);
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");

  const archive = async (): Promise<void> => {
    setState("working");
    const res = await fetch(`/api/sessions/${sessionId}/archive`, {
      method: "POST",
      credentials: "include",
    }).catch(() => null);
    setState(res?.ok ? "done" : "error");
  };

  if (state === "done") {
    return (
      <p data-testid="config-archived" className="text-[12px] text-[#c9a227]">
        Archived. No new run can start in this session.
      </p>
    );
  }

  return (
    <div className="space-y-2 border-t border-[#16211a] pt-4">
      <h2 className="text-[13px] font-semibold text-[#e6e8e6]">Archive</h2>
      {asked ? (
        <div className="space-y-2">
          <p data-testid="config-archive-warning" className="text-[12px] text-[#c9a227]">
            Archiving is permanent: no new run can start in this session afterwards, for anyone. The
            history stays readable.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="config-archive-confirm"
              disabled={state === "working"}
              onClick={archive}
              className="rounded-[9px] border border-[#c9a227] bg-[#1c1a10] px-[13px] py-[7px] font-mono text-[12px] text-[#c9a227] disabled:opacity-50"
            >
              {state === "working" ? "Archiving…" : "Yes, archive it"}
            </button>
            <button
              type="button"
              data-testid="config-archive-cancel"
              onClick={() => setAsked(false)}
              className="rounded-[9px] border border-[#17231b] bg-[#0e140f] px-[13px] py-[7px] font-mono text-[12px] text-[#cdd2cd]"
            >
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          data-testid="config-archive"
          onClick={() => setAsked(true)}
          className="rounded-[9px] border border-[#17231b] bg-[#0e140f] px-[13px] py-[7px] font-mono text-[12px] text-[#c9a227] hover:border-[#c9a227]"
        >
          Archive this session…
        </button>
      )}
      {state === "error" && (
        <p data-testid="config-archive-error" className="text-[12px] text-[#f0a8a8]">
          Could not archive this session.
        </p>
      )}
    </div>
  );
};
