import type { EventEnvelope } from "@clawdparty/contracts";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useEventStore } from "../stores/event_store";
import { useParticipantStore } from "../stores/participant_store";
import { ActivityFeed } from "./activity_feed";

/**
 * The feed always says whether Claude is working.
 *
 * Reported: "sometimes it just waits and instantly prints the output without showing the
 * loading — is it even processing". Two blind windows produced that:
 *
 *  1. **Between clicking Run and `run_started` arriving** there was no indicator at all, because
 *     the gate is `activeRunId`, and that is derived from `run_started`. On a slow first request
 *     the room sits silent with nothing to say a request is in flight.
 *  2. **A non-streaming turn** (the fallback path: Llama, Pixtral, Palmyra with tools) produces
 *     no `ai_text_delta` at all, so nothing appears until the whole turn settles. The indicator
 *     has to cover the entire turn, not just the pre-first-token part.
 *
 * The fix is a `runPending` flag the composer sets on a successful submit and the store clears
 * when the run's first durable event lands. It is UI state rather than record state, which is
 * why it is set explicitly instead of derived: no event exists yet to derive it from.
 */

let nextId = 1;
function durable(
  type: string,
  payload: Record<string, unknown> = {},
  aiRunId: string | null = "7",
): EventEnvelope {
  const id = nextId++;
  return {
    id,
    session_id: "s",
    ai_run_id: aiRunId,
    seq: id,
    type: type as EventEnvelope["type"],
    actor: { kind: "claude" },
    ts: "2026-08-17T00:00:00.000Z",
    payload,
  };
}

beforeEach(() => {
  nextId = 1;
  useEventStore.getState().reset();
  useParticipantStore
    .getState()
    .setCurrent({ id: "1", session_id: "s", role: "owner", name: "Me" });
});
afterEach(() => {
  useEventStore.getState().reset();
  useParticipantStore.getState().clear();
});

const indicator = () => screen.queryByTestId("feed-shimmer");

describe("before any event has arrived", () => {
  it("shows nothing when the room is idle", () => {
    render(<ActivityFeed />);
    expect(indicator()).not.toBeInTheDocument();
  });

  it("shows the indicator once a run has been SUBMITTED, before run_started", () => {
    // The window that read as "not even processing": the POST succeeded, the harness has not
    // emitted anything yet, so nothing is derivable from the event stream.
    useEventStore.getState().markRunPending();
    render(<ActivityFeed />);
    expect(indicator()).toBeInTheDocument();
  });
});

describe("while a run is active", () => {
  it("keeps the indicator up after run_started", () => {
    useEventStore.getState().applyMany([durable("run_started")]);
    render(<ActivityFeed />);
    expect(indicator()).toBeInTheDocument();
  });

  it("keeps it up through a tool call, when no text is streaming", () => {
    // A non-streaming turn spends its whole life here. Dropping the indicator because no text
    // has arrived is what made the UI look frozen.
    useEventStore
      .getState()
      .applyMany([
        durable("run_started"),
        durable("tool_started", { name: "bash", tool_use_id: "t", input_summary: "{}" }),
        durable("terminal_output", { text: "out", tool_use_id: "t", index: 0 }),
      ]);
    render(<ActivityFeed />);
    expect(indicator()).toBeInTheDocument();
  });

  it("clears the pending flag once the run's first event lands", () => {
    useEventStore.getState().markRunPending();
    useEventStore.getState().applyMany([durable("run_started")]);
    // Both paths now agree the run is live; the flag has done its job and must not linger, or a
    // failed submit would leave a permanent spinner.
    expect(useEventStore.getState().runPending).toBe(false);
  });
});

describe("once the run ends", () => {
  it("removes the indicator on run_finished", () => {
    useEventStore.getState().applyMany([durable("run_started"), durable("run_finished")]);
    render(<ActivityFeed />);
    expect(indicator()).not.toBeInTheDocument();
  });

  it("removes it on run_failed, so a failure does not spin forever", () => {
    useEventStore.getState().applyMany([durable("run_started"), durable("run_failed")]);
    render(<ActivityFeed />);
    expect(indicator()).not.toBeInTheDocument();
  });

  it("lets a rejected submit clear the flag explicitly", () => {
    // A 4xx from run start emits no event at all, so nothing would ever clear a pending flag —
    // the composer has to be able to withdraw it.
    useEventStore.getState().markRunPending();
    useEventStore.getState().clearRunPending();
    render(<ActivityFeed />);
    expect(indicator()).not.toBeInTheDocument();
  });
});
