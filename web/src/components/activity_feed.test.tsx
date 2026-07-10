import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EventEnvelope } from "@clawdparty/contracts";
import { act, render, screen } from "@testing-library/react";
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
    // The Write tool's chip shows the path (SPIKE_NOTE.md), not file content.
    const chips = screen.getAllByTestId("feed-tool-chip");
    const text = chips.map((c) => c.textContent).join(" ");
    expect(text).toContain("SPIKE_NOTE.md");
    expect(text).not.toContain("hello from the spike\nmore"); // no full file body
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

  it("renders an ai_raw / unknown type via the safe fallback (no crash)", () => {
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
    expect(screen.getByTestId("feed-raw-fallback")).toBeInTheDocument();
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
