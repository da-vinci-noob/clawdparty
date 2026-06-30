import { type FC, useState } from "react";
import { useCurrentParticipant } from "../hooks/use_current_participant";
import { selectActiveRunId, useEventStore } from "../stores/event_store";

// Interrupt the active run. Rendered only for owner/editor and only while a run
// is active (derived from store lifecycle events). Client gating is presentation
// only — the server enforces.
export const InterruptButton: FC = () => {
  const { can } = useCurrentParticipant();
  const activeRunId = useEventStore(selectActiveRunId);
  const [busy, setBusy] = useState(false);

  if (!can("interrupt") || !activeRunId) {
    return null;
  }

  const interrupt = async (): Promise<void> => {
    setBusy(true);
    try {
      await fetch(`/api/runs/${activeRunId}/interrupt`, { method: "POST", credentials: "include" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      data-testid="interrupt-button"
      onClick={interrupt}
      disabled={busy}
      className="rounded bg-red-700 px-2 py-1 text-xs disabled:opacity-50"
    >
      Interrupt
    </button>
  );
};
