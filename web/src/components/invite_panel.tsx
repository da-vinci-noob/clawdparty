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
  active: "text-[#3b9dff]",
  revoked: "text-[#6b726b]",
  expired: "text-[#d6b784]",
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
    <div data-testid="invite-panel" className="space-y-2">
      <h3 className="font-mono text-[10px] uppercase tracking-[1px] text-[#6b726b]">Invite</h3>
      <div className="flex gap-1">
        <select
          aria-label="Invite role"
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          className="flex-1 rounded-[9px] border border-[#17231b] bg-[#0e140f] px-[9px] py-[7px] font-mono text-[12px] text-[#cdd2cd] focus:outline-none"
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
          className="rounded-[9px] bg-[#3b9dff] px-[11px] py-[7px] font-mono text-[12px] font-semibold text-[#04101f] transition hover:brightness-110 disabled:opacity-50"
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
          className="w-full rounded-[9px] border border-[#17231b] bg-[#0e120f] px-[9px] py-[7px] font-mono text-[11px] text-[#cdd2cd]"
        />
      )}
      {error && <p className="font-mono text-[11px] text-[#f0a8a8]">{error}</p>}

      {invites.length > 0 && (
        <ul data-testid="invite-list" className="max-h-64 space-y-1 overflow-y-auto pt-1 pr-1">
          {invites.map((invite) => (
            <li
              key={invite.id}
              data-testid="invite-row"
              className="flex items-start justify-between gap-2 text-xs"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 font-mono">
                  <span className="text-[#cdd2cd]">{invite.role}</span>
                  <span className={STATUS_CLASS[invite.status]}>{invite.status}</span>
                  <span className="text-[#3a4440]">#{invite.id}</span>
                </div>
                <div className="truncate text-[11px] text-[#6b726b]">
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
                  className="shrink-0 rounded-[7px] border border-[#17231b] px-2 py-0.5 font-mono text-[#7c847c] hover:text-[#f0a8a8]"
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
