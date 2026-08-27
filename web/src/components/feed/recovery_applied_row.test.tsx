import type { EventEnvelope } from "@clawdparty/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RecoveryAppliedRow } from "./recovery_applied_row";

/**
 * an uncertain recovery SAYS the outcome is unknown.
 *
 * The whole point of this component is refusing to guess. When the harness died between
 * dispatching a request and recording its outcome, that request may have been billed and
 * may have produced output nobody recorded. A row reading "run failed" tells a participant
 * to retry work that may already have happened; "run finished" tells them to move on from
 * work that may not have. Both are claims the record cannot support, so the tests below are
 * written to fail if either creeps in.
 */

function event(payload: Record<string, unknown>): EventEnvelope {
  return {
    id: 42,
    session_id: "s",
    ai_run_id: "run_1",
    seq: 7,
    type: "recovery_applied",
    actor: { kind: "system" },
    ts: "2026-08-16T09:00:00.000Z",
    payload,
  };
}

const UNCERTAIN = {
  run_id: "run_1",
  from_phase: "request_pending",
  action: "abandoned",
  uncertain: true,
};
const CERTAIN = { run_id: "run_1", from_phase: "tools", action: "replayed", uncertain: false };

describe("an uncertain recovery states the uncertainty", () => {
  it("says the outcome is unknown, in words", () => {
    render(<RecoveryAppliedRow event={event(UNCERTAIN)} />);

    expect(screen.getByTestId("feed-recovery-uncertain")).toHaveTextContent(/unknown/i);
  });

  it("NEVER claims the run failed or finished", () => {
    render(<RecoveryAppliedRow event={event(UNCERTAIN)} />);
    const text = screen.getByTestId("feed-recovery-applied").textContent ?? "";

    // The two words a reader would act on incorrectly. "failed" sends them to retry work
    // that may already have happened; "finished" sends them past work that may not have.
    expect(text).not.toMatch(/failed/i);
    expect(text).not.toMatch(/finished/i);
  });

  it("tells the participant what to DO about it", () => {
    render(<RecoveryAppliedRow event={event(UNCERTAIN)} />);

    // Naming the uncertainty without saying what follows from it leaves the room stuck,
    // which is a different way of failing the same acceptance criterion.
    expect(screen.getByTestId("feed-recovery-applied").textContent).toMatch(/before repeating/i);
  });

  it("is marked uncertain for styling and for assertions", () => {
    render(<RecoveryAppliedRow event={event(UNCERTAIN)} />);

    expect(screen.getByTestId("feed-recovery-applied")).toHaveAttribute("data-uncertain", "true");
  });

  it("says WHAT was interrupted in plain terms, not the register name", () => {
    render(<RecoveryAppliedRow event={event(UNCERTAIN)} />);

    // `request_pending` is an internal phase name; a participant needs to know the run was
    // waiting on the model.
    const text = screen.getByTestId("feed-recovery-applied").textContent ?? "";
    expect(text).toMatch(/waiting on the model/);
    expect(text).not.toMatch(/request_pending/);
  });
});

describe("a certain recovery is quieter", () => {
  it("does not claim uncertainty when there is none", () => {
    render(<RecoveryAppliedRow event={event(CERTAIN)} />);

    // Crying wolf on every recovery would train people to ignore the row that matters.
    expect(screen.queryByTestId("feed-recovery-uncertain")).not.toBeInTheDocument();
    expect(screen.getByTestId("feed-recovery-applied")).toHaveAttribute("data-uncertain", "false");
  });

  it("still says what recovery did", () => {
    render(<RecoveryAppliedRow event={event(CERTAIN)} />);

    // Silence would leave the room wondering why the run restarted at all.
    expect(screen.getByTestId("feed-recovery-action")).toHaveTextContent(/re-ran/i);
  });
});

describe("it degrades rather than breaking", () => {
  it("renders with an empty payload", () => {
    render(<RecoveryAppliedRow event={event({})} />);

    // A recovery row that throws would take the whole feed down at exactly the moment the
    // session is already in trouble.
    expect(screen.getByTestId("feed-recovery-applied")).toBeInTheDocument();
  });

  it("passes an unknown action and phase straight through", () => {
    render(<RecoveryAppliedRow event={event({ action: "teleported", from_phase: "somewhere" })} />);

    expect(screen.getByTestId("feed-recovery-applied")).toBeInTheDocument();
  });
});
