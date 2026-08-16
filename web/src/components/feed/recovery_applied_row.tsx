import type { EventEnvelope } from "@clawdparty/contracts";
import type { FC } from "react";

/**
 * What recovery did after a crash.
 *
 * Its own row, never the generic failure banner, and the reason is the `uncertain` flag.
 * When the harness died between dispatching a request and recording its outcome, the fate
 * of that request is GENUINELY UNKNOWN — it may have been billed and may have produced
 * output nobody recorded. "Run failed" asserts it did not work; "run finished" asserts it
 * did. Both are claims the harness cannot support, and a participant who reads either will
 * make the wrong next move: retry work that already happened, or abandon work that did not.
 *
 * So an uncertain recovery says so in those words and is styled apart from failure —
 * amber-unknown rather than red-broken. The certain cases (resumed, replayed) are quieter
 * still: nothing was lost, and shouting about them would train people to ignore the row
 * that matters.
 */

interface RecoveryPayload {
  from_phase?: string;
  action?: "resumed" | "replayed" | "abandoned" | "failed";
  uncertain?: boolean;
}

/** What each action did, in the participant's terms rather than the position marker's. */
const ACTIONS: Record<string, string> = {
  resumed: "picked the run back up where it stopped",
  replayed: "re-ran the work that was safe to repeat",
  abandoned: "could not finish what was in flight",
  failed: "could not recover the run",
};

/** Phase names are internal; say what was interrupted, not which register held it. */
const PHASES: Record<string, string> = {
  checkpoint: "between turns",
  request_pending: "waiting on the model",
  tools: "running a tool",
  compacting: "summarizing history",
  terminal: "already finished",
  absent: "with no recorded position",
};

export const RecoveryAppliedRow: FC<{ event: EventEnvelope }> = ({ event }) => {
  const payload = (event.payload ?? {}) as RecoveryPayload;
  const uncertain = payload.uncertain === true;
  const action = ACTIONS[payload.action ?? ""] ?? "recovered the run";
  const phase = PHASES[payload.from_phase ?? ""] ?? payload.from_phase;

  // Amber = unknown, not red. Red is failure, and conflating them is the whole thing this
  // row exists to prevent.
  const tone = uncertain
    ? { border: "#3a2a17", bg: "#1a1206", accent: "#e0a04a", body: "#a8987a" }
    : { border: "#232a25", bg: "#141a16", accent: "#79817b", body: "#79817b" };

  return (
    <div
      data-testid="feed-recovery-applied"
      data-uncertain={uncertain ? "true" : "false"}
      className="flex items-start gap-2 rounded-[8px] border px-3 py-2 text-[12px]"
      style={{ borderColor: tone.border, backgroundColor: tone.bg }}
    >
      <span className="mt-[2px] shrink-0" style={{ color: tone.accent }} aria-hidden="true">
        {uncertain ? "?" : "↺"}
      </span>
      <div className="min-w-0">
        <div style={{ color: tone.accent }}>
          the harness restarted {phase && <span className="text-[#8a7a5a]">· {phase}</span>}
        </div>
        <div
          data-testid="feed-recovery-action"
          className="break-words"
          style={{ color: tone.body }}
        >
          {action}
          {uncertain && (
            <>
              {" — "}
              <span data-testid="feed-recovery-uncertain" style={{ color: tone.accent }}>
                whether it completed is unknown
              </span>
              . It may have run and may not have. Check before repeating it.
            </>
          )}
        </div>
      </div>
    </div>
  );
};
