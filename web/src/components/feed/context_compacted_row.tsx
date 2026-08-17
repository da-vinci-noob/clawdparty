import type { ContextCompactedPayload, EventEnvelope } from "@clawdparty/contracts";
import type { FC } from "react";

/**
 * History was summarised by the provider.
 *
 * Rendered because a compaction is the one thing that changes what Claude can still remember.
 * Without a row for it, a session silently loses its early turns and the room's only clue is
 * Claude later behaving as though it had never read them.
 *
 * Says what was replaced and how big it was. "History was summarised" alone gives a participant
 * no sense of what went, which is why `tokens_before` is on the payload at all.
 */

const tokensToK = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`;

export const ContextCompactedRow: FC<{ event: EventEnvelope }> = ({ event }) => {
  const payload = event.payload as Partial<ContextCompactedPayload>;
  const from = payload.replaced_from_seq;
  const to = payload.replaced_to_seq;
  // Only when the span is genuinely known. `0 → 0` is what an absent span defaults to, and
  // rendering that as a real range would be inventing a fact.
  const span = typeof from === "number" && typeof to === "number" && to > from;

  return (
    <div
      data-testid="feed-context-compacted"
      className="flex items-start gap-2 rounded-[8px] border border-[#1c2a3a] bg-[#0b1420] px-3 py-2 text-[12px]"
    >
      <span className="mt-[2px] shrink-0 text-[#5f9ecf]" aria-hidden="true">
        ⇥
      </span>
      <div className="min-w-0">
        <div className="text-[#5f9ecf]">
          context compacted
          {typeof payload.tokens_before === "number" && payload.tokens_before > 0 && (
            <span data-testid="feed-context-compacted-tokens" className="text-[#6d7f90]">
              {" "}
              · {tokensToK(payload.tokens_before)} before
            </span>
          )}
        </div>
        <div data-testid="feed-context-compacted-detail" className="text-[#7f909f]">
          {span
            ? `Earlier turns ${from}–${to} were replaced by a summary.`
            : "Earlier turns were replaced by a summary."}
          {payload.summary_present === false && (
            // A compaction that replaced history with NOTHING is a real and alarming state.
            // Reporting it as summarised would hide it.
            <span data-testid="feed-context-compacted-no-summary"> No summary was returned.</span>
          )}
        </div>
      </div>
    </div>
  );
};
