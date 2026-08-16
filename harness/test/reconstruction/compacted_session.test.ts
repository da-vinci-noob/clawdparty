import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@clawdparty/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as request from "../../src/loop/request_builder.js";
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
import { ToolRegistry } from "../../src/tools/registry.js";

/**
 * for a session that hit the context limit and COMPACTED.
 *
 * This is the case that breaks if blocks are flattened to text, and it breaks one turn
 * LATER than the mistake: a `compaction` block is what the API uses to stand in for the
 * history it replaced, so a request assembled without it re-sends a conversation the model
 * was told had been summarized. The symptom is a context error or a silently different
 * answer, and the cause is two turns back.
 *
 * `entryFor` attaches the turn's verbatim blocks only to `ai_text`/`ai_thinking` entries,
 * so a compaction turn's block reaches the surface by riding along with the text of that
 * same turn. The second describe block pins the case where there is no text to ride on.
 */

const CAPS: Capabilities = {
  streaming: true,
  toolUse: true,
  toolUseWhileStreaming: true,
  contextWindow: 1_000_000,
  maxOutputTokens: 64_000,
  adaptiveThinking: true,
  thinkingDisplaySummarized: true,
  effortLevels: [],
  promptCaching: false,
  minCacheablePrefixTokens: null,
  // The property under test. With this false the request never asks for compaction and
  // the whole scenario is unreachable.
  serverSideCompaction: true,
  contextEditing: false,
  serverSideTools: { webSearch: false, webFetch: false, codeExecution: false },
  liveModelDiscovery: true,
  serverSideRefusalFallback: true,
  midConversationSystemMessages: true,
  midConversationToolChanges: true,
};

const SYSTEM = "You are clawdparty.";

const COMPACTION_BLOCK = {
  type: "compaction",
  summary: "Earlier: the participant asked for a fold and Claude explained it.",
  replaced_from_seq: 1,
  replaced_to_seq: 8,
  tokens_before: 990_000,
  signature: "compaction-sig-abc",
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
  readonly boundaries: number[] = [];
  private at = 0;

  constructor(
    private readonly turns: ProviderEvent[][],
    private readonly highWater: () => number,
  ) {}

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
    this.boundaries.push(this.highWater());
    for (const event of this.turns[this.at++] ?? []) yield event;
  }
}

function turn(
  blocks: ProviderEvent[][],
  stopReason: "end_turn" | "model_context_window_exceeded",
): ProviderEvent[] {
  return [
    { t: "message_start", model: "claude-opus-5" },
    ...blocks.flat(),
    {
      t: "message_delta",
      stopReason,
      usage: {
        input_tokens: 990_000,
        output_tokens: 50,
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

const compaction = (index: number): ProviderEvent[] => [
  { t: "block_start", index, kind: "compaction" },
  { t: "block_stop", index, block: COMPACTION_BLOCK },
];

let base: string;
let dir: string;
let worktree: string;
let store: HarnessStoreApi;
let emitted: EventEnvelope[];

async function reopen(): Promise<HarnessStoreApi> {
  await store.close();
  const again = await openStore("45", { dir, owner: "reader" });
  if (!again.ok) throw new Error(`reopen failed: ${again.reason}`);
  store = again.store;
  return again.store;
}

async function run(turns: ProviderEvent[][]) {
  const adapter = new RecordingAdapter(turns, () => store.maxStoreSeq());
  const loop = new RunLoop({
    store,
    adapter,
    tools: new ToolRegistry(),
    emit: (batch) => emitted.push(...batch),
    now: () => 1_700_000_000_000,
    newId: () => "turn-1",
  });
  await loop.run({
    runId: "1",
    sessionId: "45",
    lane: "main",
    prompt: "explain the fold",
    requestedBy: "7",
    model: "claude-opus-5",
    cwd: worktree,
    systemPrompt: SYSTEM,
    signal: new AbortController().signal,
  });
  return adapter;
}

function comparable(req: ProviderRequest): string {
  const { signal: _signal, ...rest } = req;
  return JSON.stringify(rest);
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "harness-compact-"));
  dir = join(base, "store");
  worktree = join(base, "worktree");
  mkdirSync(worktree, { recursive: true });
  const opened = await openStore("45", { dir, owner: "writer" });
  if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
  store = opened.store;
  emitted = [];
});

afterEach(async () => {
  await store.close();
  rmSync(base, { recursive: true, force: true });
});

describe("a compacted session still reconstructs", () => {
  // Turn 1 hits the limit and comes back with a compaction block plus text; turn 2 is the
  // ordinary answer that follows it.
  const SCRIPT = [
    turn([compaction(0), text(1, "summarized, continuing")], "model_context_window_exceeded"),
    turn([text(0, "the fold is pure")], "end_turn"),
  ];

  it("loops rather than failing when the context window is exceeded", async () => {
    const adapter = await run(SCRIPT);

    // `model_context_window_exceeded` is NOT "the answer was cut off" — it means the
    // conversation no longer fits, and the run continues with the summary in its place.
    expect(adapter.sent).toHaveLength(2);
  });

  it("records the compaction as an event the feed can render", async () => {
    await run(SCRIPT);

    const event = emitted.find((e) => e.type === "context_compacted");
    expect(event).toBeDefined();
    // every summarization is recorded. A session that silently lost history is
    // one where nobody can explain why Claude forgot something.
    expect(event?.payload).toMatchObject({ replaced_from_seq: 1, replaced_to_seq: 8 });
  });

  it("keeps the compaction block VERBATIM on the surface", async () => {
    await run(SCRIPT);

    const surface = (await reopen()).surfaceFrom(0);
    const blocks = JSON.stringify(surface.map((e) => e.blocks));

    // `summary_present: true` in the event payload is a boolean ABOUT the summary; the
    // summary text and its signature are what the next request needs, and only the
    // verbatim block has them.
    expect(blocks).toContain(COMPACTION_BLOCK.summary);
    expect(blocks).toContain("compaction-sig-abc");
  });

  it("rebuilds the post-compaction request byte-for-byte from a reopened store", async () => {
    const adapter = await run(SCRIPT);
    const store2 = await reopen();

    const result = request.reconstruct({
      entries: store2.entriesFrom(0).filter((e) => e.store_seq <= (adapter.boundaries.at(-1) ?? 0)),
      systemPrompt: SYSTEM,
      tools: [],
      capabilities: CAPS,
      signal: new AbortController().signal,
    });

    expect(result.ok, result.ok ? "" : `refused: ${result.reason}`).toBe(true);
    if (!result.ok) return;
    expect(comparable(result.request)).toBe(comparable(adapter.sent.at(-1) as ProviderRequest));
  });

  it("carries the compaction block into the request the model actually got", async () => {
    const adapter = await run(SCRIPT);

    // The end of the chain: byte-equality above would also hold if BOTH sides had dropped
    // the block. This asserts the block was there to begin with.
    expect(JSON.stringify(adapter.sent.at(-1)?.messages)).toContain(COMPACTION_BLOCK.summary);
  });

  it("asks for server-side compaction only when the model supports it", async () => {
    const adapter = await run(SCRIPT);

    expect(adapter.sent[0]?.compaction).toBe(true);
  });
});

describe("every on-surface entry carries blocks (invariant 4)", () => {
  it("holds across a compacted multi-turn run", async () => {
    await run([
      turn([compaction(0), text(1, "summarized")], "model_context_window_exceeded"),
      turn([text(0, "answer")], "end_turn"),
    ]);

    const surface = (await reopen()).surfaceFrom(0);

    // The CHECK constraint refuses an on-surface entry with null blocks, so this cannot
    // fail without the commit having failed — asserted anyway because the constraint only
    // catches what is WRITTEN, and an entry silently left off the surface writes nothing.
    expect(surface.length).toBeGreaterThan(0);
    for (const entry of surface) {
      expect(entry.blocks, `${entry.type} is on the surface with no blocks`).not.toBeNull();
    }
  });

  it("does NOT yet carry a compaction block from a turn with no other content", async () => {
    await run([
      turn([compaction(0)], "model_context_window_exceeded"),
      turn([text(0, "answer")], "end_turn"),
    ]);

    const surface = (await reopen()).surfaceFrom(0);

    // A KNOWN GAP, asserted as-is so it is visible rather than assumed fixed.
    //
    // The turn's blocks ride on its first CLAUDE-actored entry, and `context_compacted` is
    // system-actored — so a compaction-only turn has no carrier. The fix is not just
    // "make it a carrier": folding a system-actored entry would put the compaction block in
    // a USER message, and which role the API expects it in is a provider detail this
    // codebase has never exercised (`serverSideCompaction` is derived live and was false on
    // every model tried). Guessing would produce a request that looks right and is wrong.
    //
    // Reachable only when a model reports context management AND compacts without emitting
    // any text, which is why it is a follow-up rather than a blocker. A follow-up pins the role first.
    expect(JSON.stringify(surface.map((e) => e.blocks))).not.toContain(COMPACTION_BLOCK.summary);
  });
});
