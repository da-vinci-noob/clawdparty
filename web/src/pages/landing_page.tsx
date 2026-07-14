import { type FC, type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type CurrentParticipant, useParticipantStore } from "../stores/participant_store";

// Join flow: exchange an invite token + display name for the signed httpOnly
// clawd_uid cookie (set by the server), then route into the session. The cookie
// is httpOnly — the client never reads it; it tracks "joined" from the response.
export const LandingPage: FC = () => {
  const navigate = useNavigate();
  const setCurrent = useParticipantStore((s) => s.setCurrent);
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/participants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ token, name }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          errors?: { message: string }[];
        } | null;
        setError(body?.errors?.[0]?.message ?? `Join failed (${res.status})`);
        return;
      }
      const participant = (await res.json()) as CurrentParticipant;
      setCurrent(participant);
      navigate(`/sessions/${participant.session_id}`);
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="grid h-screen place-items-center bg-neutral-950 text-neutral-100">
      <form onSubmit={onSubmit} data-testid="join-form" className="w-80 space-y-3">
        <h1 className="text-lg font-semibold">Join a clawdparty session</h1>
        <input
          aria-label="Invite token"
          placeholder="Invite token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
        />
        <input
          aria-label="Display name"
          placeholder="Display name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
        />
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-sky-600 px-2 py-1 disabled:opacity-50"
        >
          {busy ? "Joining…" : "Join"}
        </button>
        {error && (
          <p data-testid="join-error" className="text-sm text-red-400">
            {error}
          </p>
        )}
      </form>
    </main>
  );
};
