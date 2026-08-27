import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EventEnvelope } from "@clawdparty/contracts";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useEventStore } from "../stores/event_store";
import { ActivityFeed } from "./activity_feed";

// The real spike-derived executable contract (v1.1).
const fixture: EventEnvelope[] = readFileSync(
  resolve(process.cwd(), "../packages/contracts/fixtures/sample_run.jsonl"),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

// The feed is a pure reader of the event store now (the cable catch-up lives on
// the session page), so it renders without a consumer/backfill — events are
// applied to the store directly in each test.
function renderFeed() {
  return render(<ActivityFeed />);
}

describe("ActivityFeed", () => {
  beforeEach(() => useEventStore.getState().reset());
  afterEach(() => useEventStore.getState().reset());

  it("renders recovery_applied as its own row, NOT the generic run banner", async () => {
    renderFeed();
    act(() =>
      useEventStore.getState().applyMany(fixture.filter((e) => e.type === "recovery_applied")),
    );

    // A run-lifecycle banner would say "run failed" or "run finished" about a recovery, and for
    // an UNCERTAIN one both are claims the record cannot support. RawFallback
    // would show raw JSON, which is what happened before this row existed.
    expect(await screen.findByTestId("feed-recovery-applied")).toBeInTheDocument();
    expect(screen.queryByTestId("feed-run-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("feed-raw-fallback")).not.toBeInTheDocument();
  });

  it("translates the fixture's from_phase into plain terms", async () => {
    renderFeed();
    act(() =>
      useEventStore.getState().applyMany(fixture.filter((e) => e.type === "recovery_applied")),
    );

    // The fixture now carries `request_pending`, captured from a real recovery — it used to
    // say `awaiting_provider_response`, a phase name the harness never emits. A participant
    // needs to know the run was waiting on the model, not which register held it.
    const row = await screen.findByTestId("feed-recovery-applied");
    expect(row.textContent).toContain("waiting on the model");
    expect(row.textContent).not.toContain("request_pending");
  });

  it("renders the contract fixture: text bubbles, tool chips, terminal, banners, file rows", async () => {
    renderFeed();
    // Apply the fixture through the store (the live path the feed reads from).
    act(() => useEventStore.getState().applyMany(fixture));

    expect(await screen.findAllByTestId("feed-text")).not.toHaveLength(0);
    expect(screen.getAllByTestId("feed-tool-chip").length).toBeGreaterThan(0);
    expect(screen.getByTestId("feed-terminal")).toBeInTheDocument();
    expect(screen.getAllByTestId("feed-run-banner").length).toBeGreaterThan(0);
    expect(screen.getByTestId("feed-file-changed")).toBeInTheDocument();
  });

  it("renders tool chips with the SUMMARIZED input, never the full payload", () => {
    renderFeed();
    act(() => useEventStore.getState().applyMany(fixture));
    // The editor's chip shows the command and path, never `file_text`. A chip that rendered
    // the payload would put whole files — and anything in them — into the shared feed.
    const chips = screen.getAllByTestId("feed-tool-chip");
    const text = chips.map((c) => c.textContent).join(" ");
    expect(text).toContain("note.md");
    expect(text).not.toContain("First line."); // the file body must not appear
  });

  it("renders user_prompt first, then run banner, then Claude text — a conversation", () => {
    renderFeed();
    const ev = (
      over: Partial<EventEnvelope> & Pick<EventEnvelope, "type" | "seq" | "id">,
    ): EventEnvelope => ({
      session_id: "sess_demo",
      ai_run_id: "run_demo",
      actor: { kind: "claude" },
      ts: "2026-06-28T20:11:00.000Z",
      payload: {},
      ...over,
    });
    act(() =>
      useEventStore.getState().applyMany([
        ev({
          id: 1,
          seq: 1,
          type: "user_prompt",
          actor: { kind: "user", id: "42" },
          payload: { text: "do the thing" },
        }),
        ev({ id: 2, seq: 2, type: "run_started", actor: { kind: "user", id: "42" }, payload: {} }),
        ev({ id: 3, seq: 3, type: "ai_text", payload: { block: "b:0", text: "doing it" } }),
      ]),
    );

    const prompt = screen.getByTestId("feed-user-prompt");
    expect(prompt).toHaveTextContent("do the thing");
    // Distinct element from Claude's text block.
    expect(prompt).not.toBe(screen.getByTestId("feed-text"));
    // DOM order: prompt before banner before Claude text.
    const banner = screen.getByTestId("feed-run-banner");
    const claude = screen.getByTestId("feed-text");
    expect(prompt.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(banner.compareDocumentPosition(claude) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("resolves actor ids to display names from participant_joined (no #id in the feed)", () => {
    renderFeed();
    act(() =>
      useEventStore.getState().applyMany([
        {
          id: 1,
          session_id: "sess_demo",
          ai_run_id: null,
          seq: null,
          type: "participant_joined",
          actor: { kind: "user", id: "42" },
          ts: "2026-06-28T20:10:00.000Z",
          payload: { participant_id: "42", name: "Alice", role: "owner" },
        },
        {
          id: 2,
          session_id: "sess_demo",
          ai_run_id: "run_demo",
          seq: 1,
          type: "user_prompt",
          actor: { kind: "user", id: "42" },
          ts: "2026-06-28T20:11:00.000Z",
          payload: { text: "do it" },
        },
      ]),
    );
    const prompt = screen.getByTestId("feed-user-prompt");
    expect(prompt).toHaveTextContent("Alice");
    expect(prompt).not.toHaveTextContent("#42");
  });

  it("renders live thinking (ai_thinking_delta) and the durable ai_thinking as a thinking block", () => {
    renderFeed();
    // Live thinking streams into a thinking block.
    act(() =>
      useEventStore.getState().apply({
        id: null,
        session_id: "sess_demo",
        ai_run_id: "run_demo",
        seq: null,
        type: "ai_thinking_delta",
        actor: { kind: "claude" },
        ts: "2026-06-28T20:11:00.000Z",
        payload: { block: "m:0", text: "let me think" },
      }),
    );
    expect(screen.getByTestId("feed-thinking")).toHaveTextContent("let me think");

    // The durable ai_thinking settles it (still one thinking block, live cleared).
    act(() =>
      useEventStore.getState().apply({
        id: 1,
        session_id: "sess_demo",
        ai_run_id: "run_demo",
        seq: 1,
        type: "ai_thinking",
        actor: { kind: "claude" },
        ts: "2026-06-28T20:11:01.000Z",
        payload: { block: "m:0", text: "let me think" },
      }),
    );
    expect(screen.getAllByTestId("feed-thinking")).toHaveLength(1);
  });

  it("hides ai_raw events (persisted for backfill, but not rendered as feed noise)", () => {
    renderFeed();
    act(() =>
      useEventStore.getState().apply({
        id: 9999,
        session_id: "sess_demo",
        ai_run_id: "run_demo",
        seq: 99,
        type: "ai_raw",
        actor: { kind: "system" },
        ts: "2026-06-28T20:11:30.000Z",
        payload: { raw: { weird: true }, truncated: false },
      }),
    );
    // Still in the durable store (contract: never dropped), but nothing rendered.
    expect(useEventStore.getState().durableList).toHaveLength(1);
    expect(screen.queryByTestId("feed-raw-fallback")).not.toBeInTheDocument();
    expect(screen.queryByText("ai_raw")).not.toBeInTheDocument();
  });

  it("renders participant_joined as a named banner, not a raw type row", () => {
    renderFeed();
    act(() =>
      useEventStore.getState().apply({
        id: 1,
        session_id: "sess_demo",
        ai_run_id: null,
        seq: null,
        type: "participant_joined",
        actor: { kind: "user", id: "42" },
        ts: "2026-06-28T20:10:00.000Z",
        payload: { participant_id: "42", name: "Alice", role: "owner" },
      }),
    );
    const banner = screen.getByTestId("feed-run-banner");
    expect(banner).toHaveTextContent("Alice");
    expect(banner).toHaveTextContent("joined the session");
    // No raw "participant_joined" type label leaking through.
    expect(screen.queryByText("participant_joined")).not.toBeInTheDocument();
  });

  it("accumulates streamed text and renders it as a live trailing block", () => {
    renderFeed();
    const delta = (text: string): EventEnvelope => ({
      id: null,
      session_id: "sess_demo",
      ai_run_id: "run_demo",
      seq: null,
      type: "ai_text_delta",
      actor: { kind: "claude" },
      ts: "2026-06-28T20:11:00.000Z",
      payload: { block: "blkA", text },
    });
    act(() => {
      useEventStore.getState().apply(delta("Hel"));
      useEventStore.getState().apply(delta("lo"));
    });
    expect(screen.getByTestId("feed-streaming-text")).toHaveTextContent("Hello");
  });

  it("a delta flood does not grow the durable log (selector isolation)", () => {
    renderFeed();
    const delta = (text: string): EventEnvelope => ({
      id: null,
      session_id: "sess_demo",
      ai_run_id: "run_demo",
      seq: null,
      type: "ai_text_delta",
      actor: { kind: "claude" },
      ts: "2026-06-28T20:11:00.000Z",
      payload: { block: "blkA", text },
    });
    act(() => {
      for (let i = 0; i < 5000; i++) {
        useEventStore.getState().apply(delta("x"));
      }
    });
    // 5000 deltas accumulate into ONE live block; the durable log stays empty.
    expect(screen.queryAllByTestId("feed-text")).toHaveLength(0);
    expect(screen.getAllByTestId("feed-streaming-text")).toHaveLength(1);
    expect(useEventStore.getState().durableList).toHaveLength(0);
  });
});

describe("ActivityFeed auto-scroll", () => {
  beforeEach(() => useEventStore.getState().reset());
  afterEach(() => useEventStore.getState().reset());

  // Render the feed inside a scroll container with mocked layout metrics (jsdom
  // has no layout), so getScrollParent finds it and we can assert scrollTop.
  function renderInScroller(): HTMLElement {
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 100 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1000 });
    render(<ActivityFeed />, { container: scroller });
    return scroller;
  }

  function aiText(id: number, text: string): EventEnvelope {
    return {
      id,
      session_id: "s",
      ai_run_id: "r",
      seq: id,
      type: "ai_text",
      actor: { kind: "claude" },
      ts: "2026-07-22T00:00:00.000Z",
      payload: { text },
    };
  }

  it("auto-scrolls to the bottom when new content arrives while pinned", () => {
    const scroller = renderInScroller();
    act(() => useEventStore.getState().apply(aiText(1, "hello")));
    // Pinned (default) → the container is scrolled to its full scrollHeight.
    expect(scroller.scrollTop).toBe(1000);
  });

  it("does not auto-scroll when the user has scrolled up to read history", () => {
    const scroller = renderInScroller();
    // User scrolls to the top → far from the bottom → unpinned.
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    act(() => useEventStore.getState().apply(aiText(2, "new message")));
    // Their scroll position is left untouched.
    expect(scroller.scrollTop).toBe(0);
  });
});

/**
 * Consecutive thinking blocks are NOT merged into one box, and the reason is in the data.
 *
 * The question was whether a turn with several thinking blocks should render as one box, on the
 * theory that N boxes read as fragmentation when the blocks are one continuous train of thought.
 * Measured against the real record instead of judged by eye: 7 runs contain `ai_thinking`, 2
 * contain more than one (4 and 7 blocks) — and **0 adjacent `ai_thinking` pairs exist anywhere**.
 * Every multi-block run has the shape
 *
 *   ai_thinking → tool_started … tool_finished → ai_thinking → tool_started …
 *
 * which is INTERLEAVED thinking: Claude reasoned, acted, saw the result, and reasoned again.
 * Merging those would splice reasoning from before and after a tool call into one box and hide
 * that a new thought followed the result — so the current rendering is not merely defensible,
 * it is the only faithful one, and the premise for grouping does not occur.
 *
 * This test exists so a later "tidy up the thinking boxes" change cannot quietly merge them.
 */
describe("interleaved thinking stays separate", () => {
  // Its own reset: this describe is a SIBLING of the one that owns the shared hook, so it inherits
  // no cleanup. Without it the store carries rows over from earlier tests — which is why the
  // lane-label block passed in isolation and failed in the full file.
  beforeEach(() => useEventStore.getState().reset());
  afterEach(() => useEventStore.getState().reset());

  const event = (id: number, type: string, payload: object): EventEnvelope =>
    ({
      id,
      session_id: "s",
      ai_run_id: "run1",
      seq: id,
      type,
      actor: { kind: "claude" },
      ts: "2026-08-17T00:00:00Z",
      payload,
    }) as unknown as EventEnvelope;

  // The measured shape, in miniature.
  const interleaved: EventEnvelope[] = [
    event(1, "ai_thinking", { block: "b1", text: "First I should look at the file." }),
    event(2, "tool_started", { tool_use_id: "t1", name: "read", input: {} }),
    event(3, "tool_finished", { tool_use_id: "t1", output: "contents" }),
    event(4, "ai_thinking", { block: "b2", text: "Now that I have read it, the fix is clear." }),
  ];

  it("renders one box per thinking block", () => {
    renderFeed();
    act(() => useEventStore.getState().applyMany(interleaved));

    expect(screen.getAllByTestId("feed-thinking")).toHaveLength(2);
  });

  it("keeps each block's text in its OWN box, not concatenated", () => {
    renderFeed();
    act(() => useEventStore.getState().applyMany(interleaved));

    const boxes = screen.getAllByTestId("feed-thinking");
    // Merging would put "First I should look" and "Now that I have read it" in one box, reading
    // as a single thought that never happened.
    expect(boxes[0]).toHaveTextContent(/First I should look at the file/);
    expect(boxes[0]).not.toHaveTextContent(/Now that I have read it/);
    expect(boxes[1]).toHaveTextContent(/Now that I have read it/);
  });

  it("keeps the tool call BETWEEN them, which is what makes them separate thoughts", () => {
    renderFeed();
    act(() => useEventStore.getState().applyMany(interleaved));

    // Order is the evidence: thinking, then the action, then thinking about the result.
    const rendered = screen.getByTestId("activity-feed").textContent ?? "";
    expect(rendered.indexOf("First I should look")).toBeLessThan(rendered.indexOf("read"));
    expect(rendered.indexOf("read")).toBeLessThan(rendered.indexOf("Now that I have read it"));
  });
});

/**
 * The feed labels each row by lane and stays ONE ordered stream.
 *
 * Chosen over a per-lane split because the shared room is the product's central claim (,
 * enforced by `bin/check-room`), and interleaving is information: you can see two streams racing.
 * The label is what makes two concurrent streams legible without separating them.
 */
describe("lane labels", () => {
  // Its own reset: this describe is a SIBLING of the one that owns the shared hook, so it inherits
  // no cleanup. Without it the store carries rows over from earlier tests — which is why this
  // block passed in isolation and failed in the full file.
  beforeEach(() => useEventStore.getState().reset());
  afterEach(() => useEventStore.getState().reset());

  const started = (id: number, runId: string, lane?: string): EventEnvelope =>
    ({
      id,
      session_id: "s",
      ai_run_id: runId,
      seq: id,
      type: "run_started",
      actor: { kind: "user", id: "1" },
      ts: "2026-08-17T00:00:00Z",
      payload: { model: "m", cwd: "/r", ...(lane ? { lane } : {}) },
    }) as unknown as EventEnvelope;

  const text = (id: number, runId: string, body: string): EventEnvelope =>
    ({
      id,
      session_id: "s",
      ai_run_id: runId,
      seq: id,
      type: "ai_text",
      actor: { kind: "claude" },
      ts: "2026-08-17T00:00:00Z",
      payload: { block: `b${id}`, text: body },
    }) as unknown as EventEnvelope;

  it("labels a row from a non-default lane", () => {
    renderFeed();
    act(() =>
      useEventStore.getState().applyMany([started(1, "r1", "review"), text(2, "r1", "in review")]),
    );

    // Derived from `run_started`, so the label reaches a late joiner arriving by backfill too.
    expect(screen.getAllByTestId("feed-lane").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("feed-lane")[0]).toHaveTextContent("review");
  });

  it("labels NOTHING in a single-lane session", () => {
    renderFeed();
    act(() => useEventStore.getState().applyMany([started(1, "r1"), text(2, "r1", "on main")]));

    // `main` is omitted from the payload, so absence is the answer. Labelling every row "main" in a
    // session that has never opened a second lane is pure noise.
    expect(screen.queryByTestId("feed-lane")).not.toBeInTheDocument();
  });

  it("keeps ONE stream, with the two lanes interleaved in order", () => {
    renderFeed();
    act(() =>
      useEventStore
        .getState()
        .applyMany([
          started(1, "r1"),
          started(2, "r2", "review"),
          text(3, "r1", "from main"),
          text(4, "r2", "from review"),
        ]),
    );

    // Not two feeds: one ordered list. The order is the shared truth every participant sees.
    const rendered = screen.getByTestId("activity-feed").textContent ?? "";
    expect(rendered.indexOf("from main")).toBeLessThan(rendered.indexOf("from review"));
    // And only the non-default lane's rows carry a chip.
    expect(screen.getAllByTestId("feed-lane")).toHaveLength(2);
  });

  it("does not label an event that belongs to no run", () => {
    renderFeed();
    act(() =>
      useEventStore.getState().applyMany([
        started(1, "r1", "review"),
        {
          id: 5,
          session_id: "s",
          ai_run_id: null,
          seq: 5,
          type: "participant_joined",
          actor: { kind: "user", id: "9" },
          ts: "2026-08-17T00:00:00Z",
          payload: { participant_id: "9", name: "Priya", role: "editor" },
        } as unknown as EventEnvelope,
      ]),
    );

    // A session-level occurrence belongs to no work stream; attributing it to one would be a claim
    // the record does not make. One chip (the run_started row), not two.
    expect(screen.getAllByTestId("feed-lane")).toHaveLength(1);
  });
});
