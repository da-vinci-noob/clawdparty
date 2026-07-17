import { type FC, useState } from "react";
import { useCurrentParticipant } from "../hooks/use_current_participant";
import { DirectoryPicker } from "./directory_picker";

// Owner-only control to change a session's working directory for its subsequent
// runs. Reveals a DirectoryPicker; selecting a folder PATCHes /api/sessions/:id
// with { repository_path }. Client gating is presentation only — the server
// SessionPolicy (manage_session) is the authoritative gate.
export const ChangeDirectory: FC<{ sessionId: string }> = ({ sessionId }) => {
  const { can } = useCurrentParticipant();
  const [open, setOpen] = useState(false);
  const [directory, setDirectory] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!can("manage_session")) {
    return null;
  }

  const save = async (path: string): Promise<void> => {
    setDirectory(path);
    setSaved(null);
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ repository_path: path }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          errors?: { message: string }[];
        } | null;
        setError(body?.errors?.[0]?.message ?? `Update failed (${res.status})`);
        return;
      }
      const updated = (await res.json()) as { repository_path: string };
      setSaved(updated.repository_path);
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="change-directory" className="space-y-2">
      <h3 className="font-mono text-[10px] uppercase tracking-[1px] text-[#565d58]">
        Working directory
      </h3>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full rounded-[9px] border border-[#232a25] bg-[#141a16] px-[11px] py-[8px] font-mono text-[12px] text-[#d4dbd2] transition hover:border-[#374039] disabled:opacity-50"
        disabled={busy}
      >
        {open ? "Close" : "Change directory"}
      </button>
      {open && <DirectoryPicker value={directory} onChange={save} />}
      {saved !== null && (
        <p
          data-testid="change-directory-confirmation"
          className="font-mono text-[11px] text-[#4fe89a]"
        >
          Working directory set to {saved === "" ? "(repo root)" : saved}
        </p>
      )}
      {error && <p className="font-mono text-[11px] text-[#b58a7d]">{error}</p>}
    </div>
  );
};
