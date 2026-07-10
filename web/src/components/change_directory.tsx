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
    <div data-testid="change-directory" className="mt-4 space-y-2 border-t border-neutral-800 pt-3">
      <h3 className="text-xs font-semibold text-neutral-400">Working directory</h3>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded bg-sky-600 px-2 py-1 text-xs disabled:opacity-50"
        disabled={busy}
      >
        {open ? "Close" : "Change directory"}
      </button>
      {open && <DirectoryPicker value={directory} onChange={save} />}
      {saved !== null && (
        <p data-testid="change-directory-confirmation" className="text-xs text-emerald-400">
          Working directory set to {saved === "" ? "(repo root)" : saved}
        </p>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
};
