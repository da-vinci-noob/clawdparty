import { type FC, type FormEvent, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { type CurrentParticipant, useParticipantStore } from "../stores/participant_store";

type Mode = "join" | "create";

// Landing: two bootstrap entry points, both unauthenticated on the trusted LAN.
//  - Join:   invite token + display name → POST /api/participants
//  - Create: session title + display name → POST /api/sessions (creator = owner)
// Both return the participant + set the signed httpOnly clawd_uid cookie; the
// client never reads the cookie, it tracks "who am I" from the response and
// routes into the session. An invite link (?token=…) opens straight in Join mode.
export const LandingPage: FC = () => {
  const navigate = useNavigate();
  const setCurrent = useParticipantStore((s) => s.setCurrent);
  const [searchParams] = useSearchParams();

  const [mode, setMode] = useState<Mode>("join");
  const [token, setToken] = useState(() => searchParams.get("token") ?? "");
  const [title, setTitle] = useState("");
  const [name, setName] = useState("");
  // Session run mode + (chat-only) working directory for the create form.
  const [sessionMode, setSessionMode] = useState<"review" | "chat">("review");
  const [directory, setDirectory] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (url: string, body: Record<string, string>, verb: string): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const parsed = (await res.json().catch(() => null)) as {
          errors?: { message: string }[];
        } | null;
        setError(parsed?.errors?.[0]?.message ?? `${verb} failed (${res.status})`);
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

  const onJoin = (e: FormEvent): void => {
    e.preventDefault();
    void submit("/api/participants", { token, name }, "Join");
  };
  const onCreate = (e: FormEvent): void => {
    e.preventDefault();
    const body: Record<string, string> = { title, name, mode: sessionMode };
    if (sessionMode === "chat" && directory.trim()) {
      body.repository_path = directory.trim();
    }
    void submit("/api/sessions", body, "Create");
  };

  return (
    <main className="grid h-screen place-items-center bg-neutral-950 text-neutral-100">
      <div className="w-80 space-y-3">
        <div
          className="flex gap-1 rounded bg-neutral-900 p-1 text-sm"
          data-testid="landing-mode-toggle"
        >
          <button
            type="button"
            onClick={() => setMode("join")}
            className={`flex-1 rounded px-2 py-1 ${mode === "join" ? "bg-sky-600" : "text-neutral-400"}`}
          >
            Join
          </button>
          <button
            type="button"
            onClick={() => setMode("create")}
            className={`flex-1 rounded px-2 py-1 ${mode === "create" ? "bg-sky-600" : "text-neutral-400"}`}
          >
            Create
          </button>
        </div>

        {mode === "join" ? (
          <form onSubmit={onJoin} data-testid="join-form" className="space-y-3">
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
          </form>
        ) : (
          <form onSubmit={onCreate} data-testid="create-form" className="space-y-3">
            <h1 className="text-lg font-semibold">Create a clawdparty session</h1>
            <input
              aria-label="Session title"
              placeholder="Session title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
            />
            <input
              aria-label="Display name"
              placeholder="Display name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
            />
            <select
              aria-label="Session mode"
              value={sessionMode}
              onChange={(e) => setSessionMode(e.target.value as "review" | "chat")}
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
            >
              <option value="review">Review (git diff + approve/reject)</option>
              <option value="chat">Chat (run in a directory, no git)</option>
            </select>
            {sessionMode === "chat" && (
              <input
                aria-label="Working directory"
                placeholder="Working directory (optional, defaults to repo root)"
                value={directory}
                onChange={(e) => setDirectory(e.target.value)}
                className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
              />
            )}
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded bg-emerald-600 px-2 py-1 disabled:opacity-50"
            >
              {busy ? "Creating…" : "Create session"}
            </button>
          </form>
        )}

        {error && (
          <p data-testid="join-error" className="text-sm text-red-400">
            {error}
          </p>
        )}
      </div>
    </main>
  );
};
