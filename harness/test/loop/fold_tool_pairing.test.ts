import { describe, expect, it } from "vitest";
import { foldSurface } from "../../src/loop/request_builder.js";
import type { Entry } from "../../src/store/types.js";

/**
 * The fold never emits an unpaired tool_use or tool_result.
 *
 * A provider (Anthropic and Bedrock Converse alike) rejects a request whose assistant turn
 * has a `tool_use` with no matching `tool_result`, or a `tool_result` matching no `tool_use`.
 * Such an orphan lands on the surface whenever a run terminates BETWEEN emitting a tool call
 * and recording its result — an interrupt after the assistant turn settled, a provider_error
 * before dispatch, or (the case that surfaced this) a run that failed mid-turn. Once there, it
 * poisons EVERY later turn on that session: the fold replays it and the next request 400s.
 *
 * Guarding at the fold makes the request self-consistent by construction, for any provider and
 * any cause — and it is SELF-HEALING: an already-poisoned session recovers on its next turn,
 * because the fold simply stops replaying the orphan. No reset, no migration.
 */

let seq = 0;
function entry(actor: "claude" | "user", blocks: unknown[]): Entry {
  seq += 1;
  return {
    store_seq: seq,
    run_id: "1",
    seq,
    type: actor === "claude" ? "ai_text" : "tool_result",
    actor_kind: actor,
    actor_id: actor === "user" ? "7" : null,
    ts_ms: 0,
    payload: {},
    blocks,
    on_surface: 1,
    emitted: 1,
    settlement_id: null,
  } as Entry;
}

const toolUse = (id: string) => ({ type: "tool_use", id, name: "bash", input: { command: "ls" } });
const toolResult = (id: string) => ({
  type: "tool_result",
  tool_use_id: id,
  content: [{ type: "text", text: "ok" }],
  is_error: false,
});
const text = (t: string) => ({ type: "text", text: t });

function blocksOf(messages: ReturnType<typeof foldSurface>): unknown[] {
  return messages.flatMap((m) => m.content);
}
const hasToolUse = (id: string, messages: ReturnType<typeof foldSurface>) =>
  blocksOf(messages).some(
    (b) =>
      (b as { type?: string; id?: string }).type === "tool_use" && (b as { id?: string }).id === id,
  );
const hasToolResult = (id: string, messages: ReturnType<typeof foldSurface>) =>
  blocksOf(messages).some(
    (b) =>
      (b as { type?: string }).type === "tool_result" &&
      (b as { tool_use_id?: string }).tool_use_id === id,
  );

describe("a healthy surface is unchanged", () => {
  it("keeps a paired tool_use and tool_result", () => {
    const messages = foldSurface([
      entry("user", [text("run ls")]),
      entry("claude", [toolUse("call_1")]),
      entry("user", [toolResult("call_1")]),
    ]);

    expect(hasToolUse("call_1", messages)).toBe(true);
    expect(hasToolResult("call_1", messages)).toBe(true);
  });

  it("keeps assistant text alongside a paired tool_use", () => {
    const messages = foldSurface([
      entry("claude", [text("I'll list files."), toolUse("call_1")]),
      entry("user", [toolResult("call_1")]),
    ]);
    expect(blocksOf(messages).filter((b) => (b as { type?: string }).type === "text")).toHaveLength(
      1,
    );
  });
});

describe("an orphaned tool_use (the poisoning case)", () => {
  it("is dropped when no result ever followed", () => {
    // The exact shape a failed mid-tool run leaves: assistant asked to call bash, the run died
    // before any tool_result was recorded.
    const messages = foldSurface([
      entry("user", [text("run ls")]),
      entry("claude", [toolUse("call_1")]),
    ]);

    expect(hasToolUse("call_1", messages)).toBe(false);
  });

  it("drops the assistant message entirely when the tool_use was its only block", () => {
    // An empty assistant message is itself a 400. The whole message goes, not just the block.
    const messages = foldSurface([
      entry("user", [text("go")]),
      entry("claude", [toolUse("call_1")]),
    ]);
    expect(messages.some((m) => m.role === "assistant")).toBe(false);
  });

  it("keeps the assistant's text but drops only the orphaned tool_use", () => {
    const messages = foldSurface([entry("claude", [text("thinking out loud"), toolUse("call_1")])]);

    expect(hasToolUse("call_1", messages)).toBe(false);
    expect(blocksOf(messages)).toContainEqual(text("thinking out loud"));
  });

  it("drops the orphan but keeps a SIBLING tool_use that did get a result", () => {
    // Parallel tool calls where only one completed before the run died.
    const messages = foldSurface([
      entry("claude", [toolUse("call_ok"), toolUse("call_orphan")]),
      entry("user", [toolResult("call_ok")]),
    ]);

    expect(hasToolUse("call_ok", messages)).toBe(true);
    expect(hasToolUse("call_orphan", messages)).toBe(false);
  });
});

describe("an orphaned tool_result", () => {
  it("is dropped when it matches no tool_use", () => {
    // The other half of session 38's poisoning: a tool_result written with the wrong id (the
    // pre-fix empty-id bug) matches no call, and a dangling tool_result is a 400 too.
    const messages = foldSurface([
      entry("claude", [toolUse("call_real")]),
      entry("user", [toolResult(""), toolResult("call_real")]),
    ]);

    expect(hasToolResult("", messages)).toBe(false);
    expect(hasToolResult("call_real", messages)).toBe(true);
    expect(hasToolUse("call_real", messages)).toBe(true);
  });
});

describe("legacy Converse-shaped blocks", () => {
  it("recognises a {toolUse} block as a tool_use for pairing", () => {
    // A surface written before the canonical-shape fix holds `{toolUse:{toolUseId}}`.
    // The orphan check must see it, or session 38's actual poison would survive.
    const converseToolUse = { toolUse: { toolUseId: "call_legacy", name: "bash", input: {} } };
    const messages = foldSurface([entry("claude", [converseToolUse])]);

    expect(blocksOf(messages)).toHaveLength(0);
  });

  it("keeps a paired legacy {toolUse}", () => {
    const converseToolUse = { toolUse: { toolUseId: "call_legacy", name: "bash", input: {} } };
    const messages = foldSurface([
      entry("claude", [converseToolUse]),
      entry("user", [toolResult("call_legacy")]),
    ]);
    expect(blocksOf(messages).length).toBeGreaterThan(0);
  });
});

describe("blocks with no tool identity are never touched", () => {
  it("leaves text, thinking, and reasoning blocks alone", () => {
    const messages = foldSurface([
      entry("claude", [text("hi"), { type: "thinking", thinking: "hmm", signature: "s" }]),
    ]);
    expect(blocksOf(messages)).toHaveLength(2);
  });
});
