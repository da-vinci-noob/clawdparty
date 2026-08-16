import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunLoop } from "../../src/loop/run_loop.js";
import type {
  Capabilities,
  EntitlementPosture,
  ModelInfo,
  ProbeResult,
  ProviderAdapter,
  ProviderEvent,
  ProviderRequest,
} from "../../src/providers/contract.js";
import { openStore } from "../../src/store/store.js";
import type { HarnessStoreApi } from "../../src/store/types.js";
import * as read from "../../src/tools/read.js";
import { ToolRegistry } from "../../src/tools/registry.js";

/**
 * A turn's verbatim blocks appear on the model surface EXACTLY ONCE.
 *
 * Both halves of that sentence were broken, in opposite directions, and neither was visible
 * to any existing test:
 *
 *   too many  Blocks were attached to every `ai_text`/`ai_thinking` entry, so a
 *             thinking-then-text turn put the whole array on the surface twice and every
 *             later request re-sent that turn's content twice. Adaptive thinking is on by
 *             default, so this was the ordinary path — and a byte-comparison between a
 *             rebuilt request and the sent one cannot catch it, because both fold the same
 *             duplicated surface. Found by counting blocks, not by comparing requests.
 *   too few   A turn with ONLY a `tool_use` block has neither of those event types, so its
 *             block reached the surface nowhere. The next request then carried a
 *             `tool_result` with no matching `tool_use`, which the API rejects — a run that
 *             dies on its second request, from a response shape Claude produces constantly.
 */

const CAPS: Capabilities = {
  streaming: true,
  toolUse: true,
  contextWindow: 1_000_000,
  maxOutputTokens: 64_000,
  adaptiveThinking: true,
  thinkingDisplaySummarized: true,
  effortLevels: [],
  promptCaching: false,
  minCacheablePrefixTokens: null,
  serverSideCompaction: false,
  contextEditing: false,
  serverSideTools: { webSearch: false, webFetch: false, codeExecution: false },
  liveModelDiscovery: true,
  serverSideRefusalFallback: true,
  midConversationSystemMessages: true,
  midConversationToolChanges: true,
};

class RecordingAdapter implements ProviderAdapter {
  readonly id = "scripted";
  readonly displayName = "Scripted";
  readonly entitlement: EntitlementPosture = {
    credentialKind: "api_key",
    thirdPartyClientPermitted: "yes",
    note: "test",
  };
  readonly sent: ProviderRequest[] = [];
  private at = 0;

  constructor(private readonly turns: ProviderEvent[][]) {}

  async probe(): Promise<ProbeResult> {
    return { available: true, credentialSource: "env:ANTHROPIC_API_KEY" };
  }
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "claude-opus-5", displayName: "Opus", capabilities: CAPS }];
  }
  capabilities(): Capabilities {
    return CAPS;
  }
  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.sent.push(req);
    for (const event of this.turns[this.at++] ?? []) yield event;
  }
}

function turn(
  blocks: ProviderEvent[][],
  stopReason: "end_turn" | "tool_use" = "end_turn",
): ProviderEvent[] {
  return [
    { t: "message_start", model: "claude-opus-5" },
    ...blocks.flat(),
    {
      t: "message_delta",
      stopReason,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    { t: "message_stop" },
  ];
}

const text = (index: number, body: string): ProviderEvent[] => [
  { t: "block_start", index, kind: "text" },
  { t: "block_stop", index, block: { type: "text", text: body } },
];

const thinking = (index: number, body: string): ProviderEvent[] => [
  { t: "block_start", index, kind: "thinking" },
  { t: "block_stop", index, block: { type: "thinking", thinking: body, signature: "sig" } },
];

const toolUse = (index: number, id: string): ProviderEvent[] => [
  { t: "block_start", index, kind: "tool_use" },
  {
    t: "block_stop",
    index,
    block: { type: "tool_use", id, name: "read", input: { path: "x.txt" } },
  },
];

let base: string;
let worktree: string;
let store: HarnessStoreApi;

async function run(turns: ProviderEvent[][]) {
  const adapter = new RecordingAdapter(turns);
  const loop = new RunLoop({
    store,
    adapter,
    tools: new ToolRegistry().register(read.definition),
    emit: () => {},
    now: () => 1_700_000_000_000,
    newId: () => "turn-1",
  });
  await loop.run({
    runId: "1",
    sessionId: "45",
    lane: "main",
    prompt: "P",
    requestedBy: "7",
    model: "claude-opus-5",
    cwd: worktree,
    systemPrompt: "S",
    signal: new AbortController().signal,
  });
  return adapter;
}

/** Every block on the surface, flattened, in fold order. */
function surfaceBlocks(): Array<Record<string, unknown>> {
  return store.surfaceFrom(0).flatMap((e) => (e.blocks ?? []) as Array<Record<string, unknown>>);
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "harness-surface-"));
  worktree = join(base, "worktree");
  mkdirSync(worktree, { recursive: true });
  const opened = await openStore("45", { dir: join(base, "store"), owner: "surface" });
  if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
  store = opened.store;
});

afterEach(async () => {
  await store.close();
  rmSync(base, { recursive: true, force: true });
});

describe("a turn's blocks are on the surface exactly ONCE", () => {
  it("does not duplicate a thinking-then-text turn", async () => {
    await run([turn([thinking(0, "THINK"), text(1, "ANSWER")])]);

    const json = JSON.stringify(surfaceBlocks());
    // One of each. Previously two of each — silently doubling the assistant's contribution
    // to every subsequent request.
    expect(occurrences(json, "ANSWER")).toBe(1);
    expect(occurrences(json, "THINK")).toBe(1);
    // Three blocks, not five: the user's prompt plus the turn's two. Counting `type: text`
    // alone would count the prompt too, which is why the markers are asserted by name.
    expect(surfaceBlocks()).toHaveLength(3);
  });

  it("keeps them in provider block order, thinking before text", async () => {
    await run([turn([thinking(0, "THINK"), text(1, "ANSWER")])]);

    // A thinking block must be echoed back unedited AND in place; reordering is as
    // rejectable as editing.
    expect(surfaceBlocks().map((b) => b.type)).toEqual(["text", "thinking", "text"]);
  });

  it("does not duplicate a three-block turn either", async () => {
    await run([turn([thinking(0, "T1"), text(1, "A1"), text(2, "A2")])]);

    const json = JSON.stringify(surfaceBlocks());
    for (const marker of ["T1", "A1", "A2"]) {
      expect(occurrences(json, marker), `${marker} appears more than once`).toBe(1);
    }
  });
});

describe("a tool_use block reaches the surface even with NO text", () => {
  it("puts the tool_use block on the surface", async () => {
    await run([turn([toolUse(0, "toolu_1")], "tool_use"), turn([text(0, "DONE")])]);

    // The carrier is the `tool_started` entry, which is claude-actored like `ai_text`.
    expect(surfaceBlocks().some((b) => b.type === "tool_use")).toBe(true);
  });

  it("sends an assistant tool_use for every tool_result — the API rejects otherwise", async () => {
    const adapter = await run([turn([toolUse(0, "toolu_1")], "tool_use"), turn([text(0, "DONE")])]);

    const second = JSON.stringify(adapter.sent[1]?.messages ?? []);
    // THE defect, in the form the provider would see it: a `tool_result` referencing a
    // `tool_use` that is not in the preceding assistant message is a 400, so the run died
    // on its second request.
    expect(second).toContain('"tool_result"');
    expect(second).toContain('"tool_use"');
    expect(second).toContain("toolu_1");
  });

  it("still works when text accompanies the tool call", async () => {
    const adapter = await run([
      turn([text(0, "Let me look"), toolUse(1, "toolu_2")], "tool_use"),
      turn([text(0, "DONE")]),
    ]);

    const second = JSON.stringify(adapter.sent[1]?.messages ?? []);
    expect(second).toContain("toolu_2");
    // And the text is not duplicated by the carrier change.
    expect(occurrences(second, "Let me look")).toBe(1);
  });

  it("handles two parallel tool calls without duplicating either", async () => {
    const adapter = await run([
      turn([toolUse(0, "toolu_a"), toolUse(1, "toolu_b")], "tool_use"),
      turn([text(0, "DONE")]),
    ]);

    const second = JSON.stringify(adapter.sent[1]?.messages ?? []);
    // Both tool_use blocks present once each: the carrier holds the whole turn's array, so
    // parallel calls ride together rather than one being dropped.
    expect(occurrences(second, "toolu_a")).toBe(2); // the tool_use and its tool_result
    expect(occurrences(second, "toolu_b")).toBe(2);
  });
});

describe("invariant 4 holds — no on-surface entry without blocks", () => {
  it("across a tool-calling multi-turn run", async () => {
    await run([
      turn([thinking(0, "T"), text(1, "A"), toolUse(2, "toolu_1")], "tool_use"),
      turn([text(0, "DONE")]),
    ]);

    const surface = store.surfaceFrom(0);
    expect(surface.length).toBeGreaterThan(0);
    for (const entry of surface) {
      expect(entry.blocks, `${entry.type} on the surface with no blocks`).not.toBeNull();
    }
  });

  it("leaves the non-carrier entries OFF the surface rather than on it empty", async () => {
    await run([turn([thinking(0, "T"), text(1, "A")])]);

    // An on-surface entry with an empty array would satisfy the CHECK constraint and still
    // contribute nothing, which is a confusing middle state — `foldSurface` skips it, so
    // it would look like it mattered while doing nothing.
    const offSurface = store.entriesFrom(0).filter((e) => e.on_surface === 0);
    expect(offSurface.some((e) => e.type === "ai_text" || e.type === "ai_thinking")).toBe(true);
    for (const entry of offSurface) expect(entry.blocks).toBeNull();
  });
});
