import { type FC, useCallback, useEffect, useState } from "react";
import { useCurrentParticipant } from "../hooks/use_current_participant";
import type { Role } from "../stores/participant_store";

const ROLES: Role[] = ["owner", "editor", "reviewer", "viewer"];

type InviteStatus = "active" | "revoked" | "expired";

interface InviteSummary {
  id: string;
  role: Role;
  created_at: string;
  expires_at: string | null;
  status: InviteStatus;
}

const STATUS_CLASS: Record<InviteStatus, string> = {
  active: "text-emerald-400",
  revoked: "text-neutral-500",
  expired: "text-amber-400",
};

// Owner-only invite management. Mint a role-scoped link (POST) and show it once,
// list the session's invites with derived status (GET), and revoke one (DELETE).
// Client gating is presentation only — the server enforces owner via SessionPolicy.
// Tokens are hashed server-side, so a minted link is shown once and the list never
// re-displays it (metadata + status only).
export const InvitePanel: FC<{ sessionId: string }> = ({ sessionId }) => {
  const { can } = useCurrentParticipant();
  const [role, setRole] = useState<Role>("editor");
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [invites, setInvites] = useState<InviteSummary[]>([]);

  const owner = can("manage_invites");

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/invites`, {
        headers: { accept: "application/json" },
        credentials: "include",
      });
      if (res.ok) {
        setInvites((await res.json()) as InviteSummary[]);
      }
    } catch {
      // A listing outage leaves the mint form usable; action failures still surface.
    }
  }, [sessionId]);

  useEffect(() => {
    if (owner) {
      void load();
    }
  }, [owner, load]);

  if (!owner) {
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
      await load();
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string): Promise<void> => {
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/invites/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        setError(`Revoke failed (${res.status})`);
        return;
      }
      await load();
    } catch {
      setError("Network error");
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

      {invites.length > 0 && (
        <ul data-testid="invite-list" className="max-h-64 space-y-1 overflow-y-auto pt-1 pr-1">
          {invites.map((invite) => (
            <li
              key={invite.id}
              data-testid="invite-row"
              className="flex items-start justify-between gap-2 text-xs"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-neutral-300">{invite.role}</span>
                  <span className={STATUS_CLASS[invite.status]}>{invite.status}</span>
                  <span className="text-neutral-600">#{invite.id}</span>
                </div>
                <div className="truncate text-[11px] text-neutral-500">
                  {`created ${new Date(invite.created_at).toLocaleString()}`}
                  {" · "}
                  {invite.expires_at
                    ? `expires ${new Date(invite.expires_at).toLocaleDateString()}`
                    : "never expires"}
                </div>
              </div>
              {invite.status !== "revoked" && (
                <button
                  type="button"
                  aria-label={`Revoke ${invite.role} invite #${invite.id}`}
                  onClick={() => void revoke(invite.id)}
                  className="shrink-0 rounded border border-neutral-700 px-2 py-0.5 text-neutral-400 hover:text-red-400"
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
