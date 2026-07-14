import { type FC, useState } from "react";
import { useCurrentParticipant } from "../hooks/use_current_participant";
import type { Role } from "../stores/participant_store";

const ROLES: Role[] = ["owner", "editor", "reviewer", "viewer"];

// Owner-only invite minting. Calls POST /api/sessions/:id/invites for the chosen
// role and shows a copyable join link (?token=… deep-links into the join form).
// Client gating is presentation only — the server enforces owner via SessionPolicy.
export const InvitePanel: FC<{ sessionId: string }> = ({ sessionId }) => {
  const { can } = useCurrentParticipant();
  const [role, setRole] = useState<Role>("editor");
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!can("manage_invites")) {
    return null;
  }

  const mint = async (): Promise<void> => {
    setError(null);
    setLink(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/invites`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          errors?: { message: string }[];
        } | null;
        setError(body?.errors?.[0]?.message ?? `Invite failed (${res.status})`);
        return;
      }
      const { token } = (await res.json()) as { token: string };
      setLink(`${window.location.origin}/?token=${encodeURIComponent(token)}`);
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="invite-panel" className="mt-4 space-y-2 border-t border-neutral-800 pt-3">
      <h3 className="text-xs font-semibold text-neutral-400">Invite</h3>
      <div className="flex gap-1">
        <select
          aria-label="Invite role"
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-1 py-1 text-xs"
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={mint}
          disabled={busy}
          className="rounded bg-sky-600 px-2 py-1 text-xs disabled:opacity-50"
        >
          {busy ? "…" : "Create link"}
        </button>
      </div>
      {link && (
        <input
          aria-label="Invite link"
          data-testid="invite-link"
          readOnly
          value={link}
          onFocus={(e) => e.currentTarget.select()}
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-1 py-1 text-xs text-neutral-300"
        />
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
};
