import type { EventEnvelope } from "@clawdparty/contracts";
import { AI_RAW, EVENT_TYPES, SYNTHESIZED_EVENT_TYPES } from "@clawdparty/contracts";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useEventStore } from "../stores/event_store";
import { ActivityFeed } from "./activity_feed";

/**
 * The web CONSUMES what the harness PRODUCES.
 *
 * Four contract changes shipped one side at a time with both suites green — the `/models` shape,
 * `context_usage`, `provider` on run start (S2), and `provider_error` — because the web tests
 * mocked a hand-written shape while the harness tests asserted the real one and nothing exercised
 * the seam. That is a recurring CLASS, not four incidents.
 *
 * Typing the web's fixtures against `packages/contracts` closed the shape half: a rename is now a
 * compile error. This closes the other half — that every event type the harness can emit has
 * somewhere to GO in the UI. `provider_error` was emitted from two code paths for months and landed
 * as a raw JSON dump, which no test could have caught: the feed has a `default` branch, so an
 * unrendered type produces valid output rather than an error.
 *
 * The rule enforced below: every type is EITHER rendered as something meaningful OR listed in
 * `DELIBERATELY_NOT_RENDERED` with a reason. Both lists are derived from the contract, so a new
 * type fails this test until someone decides which it is — the decision cannot be skipped, only
 * made.
 */

/**
 * Types with no user-facing row, each for a stated reason.
 *
 * The reasons are the content of this table; a type parked here without one is just a suppressed
 * failure.
 */
const DELIBERATELY_NOT_RENDERED: Record<string, string> = {
  // The normalizer's safety valve for unmapped provider messages. Persisted (the contract says
  // never dropped) and available via backfill, but it is raw vendor data with no meaning to a
  // participant — rendering it would be noise that looks like a malfunction.
  ai_raw: "raw provider passthrough; persisted for audit, not for reading",
  // Paired into their tool_started chip, which is where a reader looks for a tool's outcome.
  tool_finished: "rendered as part of its tool_started chip",
  tool_failed: "rendered as part of its tool_started chip",
  // The request snapshot. It is a fact about the REQUEST, not about the conversation, and it
  // changes on emit-on-change turns only; the settings page is where a participant sees the
  // resolved scope.
  request_header: "request provenance for the record; the resolved scope is shown in settings",
  // Two-tier streaming: the deltas ARE the live text, accumulated into the block the feed already
  // renders. A row per delta would be one row per token.
  ai_text_delta: "accumulated into the streaming text block",
  ai_thinking_delta: "accumulated into the streaming thinking block",
  // Presence is a roster state, not a timeline occurrence.
  presence_changed: "drives the participant roster, not the feed",
  // The live context bar reads this; a feed row per turn would bury the run.
  context_usage: "drives the live CONTEXT bar in the composer",
  // Chat is its own panel, deliberately separate from the run timeline.
  chat_message: "rendered in the chat panel",
  // The task board was cut from the MVP (PLAN §12).
  task_created: "task board is out of MVP scope",
  task_updated: "task board is out of MVP scope",
};

/** Minimal payloads — enough for each renderer to produce its row. */
function payloadFor(type: string): Record<string, unknown> {
  switch (type) {
    case "ai_text":
    case "ai_thinking":
      return { block: "b1", text: "some words" };
    case "user_prompt":
      return { text: "do the thing" };
    case "tool_started":
      return { tool_use_id: "t1", name: "read", input: {} };
    case "terminal_output":
      return { tool_use_id: "t1", chunk_index: 0, text: "output line" };
    case "file_changed":
      return { path: "README.md", change: "modified" };
    case "context_compacted":
      return {
        replaced_from_seq: 1,
        replaced_to_seq: 9,
        tokens_before: 100,
        summary_present: true,
      };
    case "tool_refused":
      return { name: "bash", by: "policy", reason: "outside the worktree" };
    case "provider_error":
      return { provider: "p", kind: "credential_expired", message: "m", remedy: "r" };
    case "recovery_applied":
      return { run_id: "r1", from_phase: "request_pending", action: "resumed", uncertain: true };
    case "plugin_enabled":
    case "plugin_disabled":
      return { id: "a-plugin", version: "1.0.0", origin: "third_party" };
    case "skill_changed":
      return { action: "added", name: "deploy", scope: "repo" };
    case "run_started":
      return { model: "m", cwd: "/r" };
    case "run_finished":
      return { stop_reason: "end_turn", usage: {}, total_cost_usd: null };
    case "run_failed":
      return { stop_reason: "refusal", explanation: "why", usage: {} };
    case "changeset_ready":
      return { files_changed: 1, insertions: 2, deletions: 0 };
    case "changeset_approved":
      return { commit_sha: "abc123" };
    default:
      return {};
  }
}

const event = (type: string): EventEnvelope =>
  ({
    id: 1,
    session_id: "s",
    ai_run_id: "run_1",
    seq: 1,
    type,
    actor: type === "user_prompt" ? { kind: "user", id: "7" } : { kind: "system" },
    ts: "2026-08-17T00:00:00.000Z",
    payload: payloadFor(type),
  }) as unknown as EventEnvelope;

/**
 * Everything the `type` field may hold: the 31 names PLUS the `ai_raw` fallback, which is a real
 * emitted type and deliberately not a member of `EVENT_TYPES`. Using `EVENT_TYPES` alone here left
 * `ai_raw` unaccounted for — caught by the stale-entry assertion below, which is the guard doing
 * its job on its own first run.
 */
const ALL_EMITTED: readonly string[] = [...EVENT_TYPES, AI_RAW];

/**
 * Types whose renderer is genuinely NOT WRITTEN YET, each named with the work that owns it.
 *
 * A third category on purpose. Parking these in `DELIBERATELY_NOT_RENDERED` would record a decision
 * nobody made — the feature is simply unbuilt — and asserting them as rendered would fail CI over
 * work that is correctly scheduled rather than missed. This guard found them on its first run, which
 * is the whole reason it exists: `plugin_enabled`/`plugin_disabled` are in the taxonomy and land in
 * the raw fallback today.
 *
 * It is now EMPTY, which is the intended end state: `plugin_enabled`/`plugin_disabled` were the
 * last two entries and now render. Kept rather than deleted, because the next type added on the
 * harness side needs somewhere honest to sit while its renderer is written.
 */
const PENDING_RENDERER: Record<string, string> = {};

const RENDERED = ALL_EMITTED.filter(
  (type) => !(type in DELIBERATELY_NOT_RENDERED) && !(type in PENDING_RENDERER),
);

beforeEach(() => useEventStore.getState().reset());
afterEach(() => useEventStore.getState().reset());

describe("every event type is accounted for", () => {
  it("partitions the whole taxonomy into rendered and deliberately-not", () => {
    const covered = new Set([
      ...RENDERED,
      ...Object.keys(DELIBERATELY_NOT_RENDERED),
      ...Object.keys(PENDING_RENDERER),
    ]);
    const missing = ALL_EMITTED.filter((type) => !covered.has(type));

    // Cannot fail by construction today — it is here so that if the partition is ever changed to
    // something lossier, the arithmetic says so.
    expect(missing).toEqual([]);
    expect(covered.size).toBe(ALL_EMITTED.length);
  });

  it("gives every not-rendered type a REASON, not just an entry", () => {
    for (const [type, reason] of Object.entries(DELIBERATELY_NOT_RENDERED)) {
      // A type parked in the table without a reason is a suppressed failure wearing a comment.
      expect(reason.length, type).toBeGreaterThan(15);
    }
  });

  it("lists only real event types, so a stale entry cannot hide a missing renderer", () => {
    // If a type is renamed in the contract and either table keeps the old name, the new name would
    // silently fall through to the raw fallback while the table still looked complete.
    for (const type of [
      ...Object.keys(DELIBERATELY_NOT_RENDERED),
      ...Object.keys(PENDING_RENDERER),
    ]) {
      expect(ALL_EMITTED, `${type} is not an emitted type`).toContain(type);
    }
  });

  it("gives every PENDING renderer a real note, not a bare TODO", () => {
    for (const [type, note] of Object.entries(PENDING_RENDERER)) {
      // "not done yet" without an owner is how a gap becomes permanent.
      expect(note.length, type).toBeGreaterThan(15);
    }
  });
});

describe("each rendered type produces a real row, not the raw fallback", () => {
  for (const type of RENDERED) {
    it(`renders ${type}`, () => {
      render(<ActivityFeed names={new Map()} />);
      act(() => useEventStore.getState().apply(event(type)));

      // The raw fallback IS valid output, which is exactly why this needs asserting: an unrendered
      // type looks fine on screen and is a JSON dump in front of a participant.
      expect(
        screen.queryByTestId("feed-raw-fallback"),
        `${type} fell through to the raw fallback`,
      ).not.toBeInTheDocument();
      // And something was actually drawn — a renderer that returns null for a type in the RENDERED
      // set would otherwise pass the check above trivially.
      expect(screen.getByTestId("activity-feed").textContent?.length ?? 0).toBeGreaterThan(0);
    });
  }
});

describe("the synthesized types specifically", () => {
  it("are all either rendered or explained", () => {
    // These are the types the HARNESS invents — the ones with no provider message behind them, and
    // therefore the ones most likely to be added on the harness side and forgotten on the web side.
    // That is precisely how `provider_error` shipped without a renderer.
    for (const type of SYNTHESIZED_EVENT_TYPES) {
      const accounted =
        RENDERED.includes(type) || type in DELIBERATELY_NOT_RENDERED || type in PENDING_RENDERER;
      expect(accounted, `${type} is neither rendered nor explained`).toBe(true);
    }
  });
});
