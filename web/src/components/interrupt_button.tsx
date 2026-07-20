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
      className="mb-[10px] flex items-center gap-[6px] rounded-[9px] border border-[#332723] bg-[#1a0e0e] px-[11px] py-[6px] font-mono text-[12px] text-[#f0a8a8] transition hover:border-[#4a2f28] disabled:opacity-50"
    >
      <span className="h-[7px] w-[7px] rounded-full bg-[#f0a8a8]" /> Interrupt
      <span className="text-[#5c4a44]">esc</span>
    </button>
  );
};
