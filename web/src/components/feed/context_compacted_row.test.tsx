import type { ContextCompactedPayload, EventEnvelope } from "@clawdparty/contracts";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useEventStore } from "../../stores/event_store";
import { ContextCompactedRow } from "./context_compacted_row";

/**
 * a compaction renders IDENTICALLY for a live participant and a late joiner.
 *
 * That is a claim about the transport as much as the component: `context_compacted` is DURABLE
 * (unlike `context_usage`), so it is persisted, backfilled, and must therefore reach someone who
 * arrives afterwards exactly as it reached the room at the time. The test below drives both paths
 * into the store and compares the rendered markup, rather than asserting the component twice —
 * comparing output is what makes "identically" mean something.
 *
 * The payload type comes from `packages/contracts`, so a rename on the harness side is a compile
 * error here rather than a row that silently renders nothing.
 */

const PAYLOAD: ContextCompactedPayload = {
  replaced_from_seq: 3,
  replaced_to_seq: 41,
  tokens_before: 195_000,
  summary_present: true,
};

const event = (payload: Partial<ContextCompactedPayload>): EventEnvelope =>
  ({
    id: 7,
    session_id: "s",
    ai_run_id: "run1",
    seq: 42,
    type: "context_compacted",
    actor: { kind: "system" },
    ts: "2026-08-17T00:00:00Z",
    payload,
  }) as unknown as EventEnvelope;

beforeEach(() => useEventStore.getState().reset());
afterEach(() => useEventStore.getState().reset());

describe("what the row says", () => {
  it("names the span that was replaced", () => {
    render(<ContextCompactedRow event={event(PAYLOAD)} />);
    expect(screen.getByTestId("feed-context-compacted-detail")).toHaveTextContent(
      /turns 3–41 were replaced/,
    );
  });

  it("names the pre-compaction size, which is what says how much went", () => {
    render(<ContextCompactedRow event={event(PAYLOAD)} />);
    expect(screen.getByTestId("feed-context-compacted-tokens")).toHaveTextContent("195K before");
  });

  it("does not invent a span when the provider reported none", () => {
    // An absent span defaults to 0 on the payload, and "turns 0–0 were replaced" would be a
    // fabricated fact rather than a missing one.
    render(<ContextCompactedRow event={event({ tokens_before: 100 })} />);

    expect(screen.getByTestId("feed-context-compacted-detail")).toHaveTextContent(
      /^Earlier turns were replaced by a summary\.$/,
    );
  });

  it("says so when history was replaced by NOTHING", () => {
    render(<ContextCompactedRow event={event({ ...PAYLOAD, summary_present: false })} />);

    // A real and alarming state. Rendering it the same as a successful compaction hides it.
    expect(screen.getByTestId("feed-context-compacted-no-summary")).toBeInTheDocument();
  });

  it("omits the token figure rather than showing 0K", () => {
    render(<ContextCompactedRow event={event({ ...PAYLOAD, tokens_before: 0 })} />);

    expect(screen.queryByTestId("feed-context-compacted-tokens")).not.toBeInTheDocument();
  });
});

describe("live and late-joining participants see the same thing", () => {
  /** Render whatever the store holds for the compaction, after applying `stream`. */
  function renderAfter(stream: EventEnvelope[]): string {
    useEventStore.getState().reset();
    useEventStore.getState().applyMany(stream);
    const compacted = useEventStore
      .getState()
      .durableList.find((e) => e.type === "context_compacted");
    if (!compacted) throw new Error("the store dropped context_compacted");
    const { container } = render(<ContextCompactedRow event={compacted} />);
    return container.innerHTML;
  }

  const live: EventEnvelope[] = [
    { ...event(PAYLOAD), id: 5, type: "run_started", payload: { model: "m", cwd: "/r" } },
    event(PAYLOAD),
    { ...event(PAYLOAD), id: 9, type: "ai_text", payload: { block: "b", text: "after" } },
  ];

  it("renders identically whether it arrived live or via backfill", () => {
    // The late joiner's path: the same durable events, delivered by REST backfill after they
    // arrived, plus a duplicate the drain step is expected to dedupe by id.
    const lateJoiner = [...live, event(PAYLOAD)];

    expect(renderAfter(lateJoiner)).toBe(renderAfter(live));
  });

  it("reaches the late joiner exactly once, not twice", () => {
    useEventStore.getState().reset();
    useEventStore.getState().applyMany([...live, event(PAYLOAD)]);

    // Durable, so unlike `context_usage` it IS backfilled — and dedupe-by-id is what keeps the
    // overlap between backfill and the live buffer from showing the occurrence twice.
    expect(
      useEventStore.getState().durableList.filter((e) => e.type === "context_compacted"),
    ).toHaveLength(1);
  });
});
