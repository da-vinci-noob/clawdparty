import { type FC, type FormEvent, useState } from "react";
import { useCurrentParticipant } from "../hooks/use_current_participant";
import {
  selectActiveRunId,
  selectAwaitingReviewRunId,
  selectExecutablePlanRunId,
  useEventStore,
} from "../stores/event_store";

// The Claude permission modes a user may pick (CLI Shift+Tab). Bypass is owner-only
// (it ignores the tool whitelist); the server re-enforces every choice.
type PermissionMode = "plan" | "acceptEdits" | "bypassPermissions";
const MODE_OPTIONS: { value: PermissionMode; label: string; ownerOnly?: boolean }[] = [
  { value: "plan", label: "Plan" },
  { value: "acceptEdits", label: "Auto-accept" },
  { value: "bypassPermissions", label: "Bypass", ownerOnly: true },
];

// Prompt composer: starts a run when none is active, sends a follow-up when one is,
// and submits a `revise` follow-up while awaiting review. When starting a run the
// user picks Claude's permission mode; after a finished Plan run an "Execute plan"
// shortcut starts an auto-accept run that resumes the session. Rendered only for
// owner/editor (client gating is presentation only — the server SessionPolicy gates).
export const PromptComposer: FC<{ sessionId: string }> = ({ sessionId }) => {
  const { can } = useCurrentParticipant();
  const activeRunId = useEventStore(selectActiveRunId);
  const reviewRunId = useEventStore(selectAwaitingReviewRunId);
  const planRunId = useEventStore(selectExecutablePlanRunId);
  const [text, setText] = useState("");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("acceptEdits");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!can("run")) {
    return null;
  }

  const revising = !activeRunId && reviewRunId !== null;

  const startRun = (prompt: string, mode: PermissionMode): Promise<Response> =>
    fetch(`/api/sessions/${sessionId}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        prompt,
        permission_mode: mode,
        ...(revising ? { mode: "revise" } : {}),
      }),
    });

  const surfaceError = async (res: Response): Promise<boolean> => {
    if (res.ok) {
      return true;
    }
    const body = (await res.json().catch(() => null)) as { errors?: { message: string }[] } | null;
    setError(body?.errors?.[0]?.message ?? `Request failed (${res.status})`);
    return false;
  };

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
        : await startRun(text, permissionMode);
      if (await surfaceError(res)) {
        setText("");
      }
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  };

  // A finished Plan run made no edits; a fresh auto-accept run resumes its session
  // and executes the plan (edits then flow through changeset review).
  const executePlan = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await surfaceError(await startRun("Execute the plan you just proposed.", "acceptEdits"));
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  };

  const showModeControl = !activeRunId; // a new run is created (start or revise)
  const modeOptions = MODE_OPTIONS.filter((m) => !m.ownerOnly || can("bypass_permissions"));

  return (
    <form
      onSubmit={submit}
      data-testid="prompt-composer"
      className="flex flex-col gap-2 border-t border-neutral-800 p-2"
    >
      {planRunId && !activeRunId && (
        <button
          type="button"
          data-testid="execute-plan"
          onClick={() => void executePlan()}
          disabled={busy}
          className="self-start rounded bg-emerald-700 px-3 py-1 text-xs disabled:opacity-50"
        >
          Execute plan
        </button>
      )}
      <div className="flex gap-2">
        {showModeControl && (
          <select
            aria-label="Permission mode"
            data-testid="permission-mode"
            value={permissionMode}
            onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}
            className="rounded border border-neutral-700 bg-neutral-900 px-1 py-1 text-sm"
          >
            {modeOptions.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        )}
        <input
          aria-label="Prompt"
          placeholder={
            activeRunId ? "Send a follow-up…" : revising ? "Revise the changes…" : "Start a run…"
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-sky-600 px-3 py-1 text-sm disabled:opacity-50"
        >
          {activeRunId ? "Send" : revising ? "Revise" : "Run"}
        </button>
      </div>
      {error && (
        <p data-testid="composer-error" className="text-sm text-red-400">
          {error}
        </p>
      )}
    </form>
  );
};
