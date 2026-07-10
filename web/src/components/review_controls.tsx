import { type FC, useState } from "react";
import { useCurrentParticipant } from "../hooks/use_current_participant";

// Approve / reject the run awaiting review. Owner-only (`can("approve")`); the
// server SessionPolicy is the authoritative gate, this only hides the buttons.
// On success the run leaves `awaiting_review` via the event stream, so there is
// no manual refetch here. A server refusal (e.g. wrong state, 403) is surfaced.
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
      <button
        type="button"
        data-testid="approve-button"
        onClick={() => act("approve")}
        disabled={busy}
        className="rounded bg-emerald-600 px-3 py-1 text-sm disabled:opacity-50"
      >
        Approve
      </button>
      <button
        type="button"
        data-testid="reject-button"
        onClick={() => act("reject")}
        disabled={busy}
        className="rounded bg-red-700 px-3 py-1 text-sm disabled:opacity-50"
      >
        Reject
      </button>
      {error && (
        <p data-testid="review-error" className="text-sm text-red-400">
          {error}
        </p>
      )}
    </div>
  );
};
