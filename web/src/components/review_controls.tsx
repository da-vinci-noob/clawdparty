import { type FC, useState } from "react";
import { useCurrentParticipant } from "../hooks/use_current_participant";

// Approve / reject the run awaiting review, styled to the dark-green design's
// review card (filled blue "approve", outlined "reject"). Owner-only
// (`can("approve")`); the server SessionPolicy is the authoritative gate, this
// only hides the buttons. On success the run leaves `awaiting_review` via the
// event stream, so there is no manual refetch here. A server refusal (e.g. wrong
// state, 403) is surfaced. Non-owners render nothing (the parent footer still
// shows the "only owner can approve" hint).
export const ReviewControls: FC<{ runId: string }> = ({ runId }) => {
  const { can } = useCurrentParticipant();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!can("approve")) {
    return null;
  }

  const act = async (action: "approve" | "reject"): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/runs/${runId}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          errors?: { message: string }[];
        } | null;
        setError(body?.errors?.[0]?.message ?? `Request failed (${res.status})`);
      }
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="review-controls" className="flex items-center gap-2">
      {error && (
        <p data-testid="review-error" className="mr-1 text-[12px] text-[#f0a8a8]">
          {error}
        </p>
      )}
      <button
        type="button"
        data-testid="approve-button"
        onClick={() => act("approve")}
        disabled={busy}
        className="flex items-center gap-[6px] rounded-[9px] bg-[#3b9dff] px-[15px] py-[7px] font-mono text-[12px] font-semibold text-[#04101f] shadow-[0_0_14px_rgba(59,157,255,.28)] transition hover:brightness-110 disabled:opacity-50"
      >
        <span aria-hidden="true">✓</span> approve
      </button>
      <button
        type="button"
        data-testid="reject-button"
        onClick={() => act("reject")}
        disabled={busy}
        className="rounded-[9px] border border-[#3a2020] bg-[#140c0c] px-[15px] py-[7px] font-mono text-[12px] text-[#f0a8a8] transition hover:border-[#5a3030] hover:bg-[#1a0e0e] disabled:opacity-50"
      >
        reject
      </button>
    </div>
  );
};
