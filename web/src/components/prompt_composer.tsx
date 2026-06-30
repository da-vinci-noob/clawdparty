import { type FC, type FormEvent, useState } from "react";
import { useCurrentParticipant } from "../hooks/use_current_participant";
import { selectActiveRunId, useEventStore } from "../stores/event_store";

// Prompt composer: starts a run when none is active, sends a follow-up when one
// is. Rendered only for owner/editor (client gating is presentation only — the
// server SessionPolicy is the gate). Active-run state derives from the store's
// lifecycle events, not a bespoke message.
export const PromptComposer: FC<{ sessionId: string }> = ({ sessionId }) => {
  const { can } = useCurrentParticipant();
  const activeRunId = useEventStore(selectActiveRunId);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!can("run")) {
    return null;
  }

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!text.trim()) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = activeRunId
        ? await fetch(`/api/runs/${activeRunId}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ message: text }),
          })
        : await fetch(`/api/sessions/${sessionId}/runs`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ prompt: text }),
          });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          errors?: { message: string }[];
        } | null;
        setError(body?.errors?.[0]?.message ?? `Request failed (${res.status})`);
        return;
      }
      setText("");
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      data-testid="prompt-composer"
      className="flex gap-2 border-t border-neutral-800 p-2"
    >
      <input
        aria-label="Prompt"
        placeholder={activeRunId ? "Send a follow-up…" : "Start a run…"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
      />
      <button
        type="submit"
        disabled={busy}
        className="rounded bg-sky-600 px-3 py-1 text-sm disabled:opacity-50"
      >
        {activeRunId ? "Send" : "Run"}
      </button>
      {error && (
        <p data-testid="composer-error" className="text-sm text-red-400">
          {error}
        </p>
      )}
    </form>
  );
};
