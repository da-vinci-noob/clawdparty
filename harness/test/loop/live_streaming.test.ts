import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@clawdparty/contracts";
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
import { ToolRegistry } from "../../src/tools/registry.js";

/**
 * a delta reaches the room WHILE the turn is still running.
 *
 * `streamTurn` accumulated every mapped event into a local array and the loop called
 * `emit(turn.events)` once, at the turn boundary. So `ai_text_delta` carried no earlier
 * information than the `ai_text` it precedes: both arrived in the same flush, after the
 * model had finished. The two-tier design was in place and delivering nothing — a
 * participant watched a spinner for the whole turn and then got the paragraph at once.
 *
 * Verified in production before writing this: run 55 on session 38 streamed a 592-character
 * paragraph, and Rails logged ONE `/internal/events` POST carrying the whole thing, stamped
 * after the run's own `ai_text`. The turn took seconds; a live stream at a 150ms window
 * would have been dozens of batches.
 *
 * The assertion is deliberately made from INSIDE the generator. A test that checked the
 * emit log after `loop.run()` resolved would pass against turn-boundary batching, which is
 * exactly the defect.
 */

const CAPS: Capabilities = {
  streaming: true,
  toolUse: true,
  toolUseWhileStreaming: true,
  contextWindow: 1_000_000,
  maxOutputTokens: 64_000,
  adaptiveThinking: true,
  thinkingBudgetTokens: null,
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

/** Yields a scripted turn, calling `onYield` after each event so the test can observe what
 *  has been emitted at that exact point in the stream. */
class ObservableAdapter implements ProviderAdapter {
  readonly id = "scripted";
  readonly displayName = "Scripted";
  readonly entitlement: EntitlementPosture = {
    credentialKind: "api_key",
    thirdPartyClientPermitted: "yes",
    note: "test",
  };

  constructor(
    private readonly events: ProviderEvent[],
    private readonly onYield: (event: ProviderEvent) => void,
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
  async *stream(_req: ProviderRequest): AsyncIterable<ProviderEvent> {
    for (const event of this.events) {
      yield event;
      this.onYield(event);
    }
  }
}

const usage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

let base: string;
let worktree: string;
let store: HarnessStoreApi;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "harness-live-"));
  worktree = join(base, "worktree");
  mkdirSync(worktree, { recursive: true });
  const opened = await openStore("45", { dir: join(base, "store"), owner: "live" });
  if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
  store = opened.store;
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

interface Observation {
  /** The provider event that had just been consumed. */
  after: string;
  /** Every event type emitted so far, in emission order. */
  emitted: string[];
  /** Text delivered so far, concatenated in emission order. */
  text: string;
}

async function runObserving(events: ProviderEvent[]): Promise<{
  observations: Observation[];
  emitted: EventEnvelope[];
}> {
  const emitted: EventEnvelope[] = [];
  const observations: Observation[] = [];

  const adapter = new ObservableAdapter(events, (event) => {
    observations.push({
      after: event.t,
      emitted: emitted.map((e) => e.type),
      text: emitted
        .filter((e) => e.type === "ai_text_delta")
        .map((e) => (e.payload as { text: string }).text)
        .join(""),
    });
  });

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
    prompt: "P",
    requestedBy: "7",
    model: "claude-opus-5",
    cwd: worktree,
    systemPrompt: "S",
    signal: new AbortController().signal,
  });

  return { observations, emitted };
}

const paragraph = ["A git worktree ", "is a second ", "working directory."];

function textTurn(): ProviderEvent[] {
  return [
    { t: "message_start", model: "claude-opus-5" },
    { t: "block_start", index: 0, kind: "text" },
    ...paragraph.map((text) => ({ t: "text_delta" as const, index: 0, text })),
    { t: "block_stop", index: 0, block: { type: "text", text: paragraph.join("") } },
    { t: "message_delta", stopReason: "end_turn" as const, usage },
    { t: "message_stop" as const },
  ];
}

describe("deltas are emitted DURING the turn", () => {
  it("delivers each delta before the next one is produced", async () => {
    const { observations } = await runObserving(textTurn());

    // One observation per provider event, so the text delivered at each point is checkable
    // against what the model had produced by then.
    const afterDeltas = observations.filter((o) => o.after === "text_delta");
    expect(afterDeltas.map((o) => o.text)).toEqual([
      "A git worktree ",
      "A git worktree is a second ",
      "A git worktree is a second working directory.",
    ]);
  });

  it("delivers the whole paragraph BEFORE the block settles", async () => {
    const { observations } = await runObserving(textTurn());
    const atBlockStop = observations.find((o) => o.after === "block_stop");

    // The durable `ai_text` is written at settlement. If the deltas had not gone out by
    // now, the two-tier split bought nothing — the participant learns the text either way
    // at the same moment.
    expect(atBlockStop?.text).toBe(paragraph.join(""));
    expect(atBlockStop?.emitted).not.toContain("ai_text");
  });

  it("still emits the durable ai_text, exactly once, after the deltas", async () => {
    const { emitted } = await runObserving(textTurn());
    const types = emitted.map((e) => e.type);

    expect(types.filter((t) => t === "ai_text")).toHaveLength(1);
    expect(types.lastIndexOf("ai_text_delta")).toBeLessThan(types.indexOf("ai_text"));
  });

  it("emits each delta ONCE — never live and again at the turn boundary", async () => {
    const { emitted } = await runObserving(textTurn());

    // The client ACCUMULATES deltas, so a duplicate does not dedupe — it doubles the
    // paragraph on screen. This is the failure mode of emitting live without removing the
    // ephemeral events from the turn's batch.
    const text = emitted
      .filter((e) => e.type === "ai_text_delta")
      .map((e) => (e.payload as { text: string }).text)
      .join("");
    expect(text).toBe(paragraph.join(""));
  });

  it("streams thinking deltas live too", async () => {
    const { observations } = await runObserving([
      { t: "message_start", model: "claude-opus-5" },
      { t: "block_start", index: 0, kind: "thinking" },
      { t: "thinking_delta", index: 0, text: "weighing " },
      { t: "thinking_delta", index: 0, text: "options" },
      {
        t: "block_stop",
        index: 0,
        block: { type: "thinking", thinking: "weighing options", signature: "sig" },
      },
      { t: "message_delta", stopReason: "end_turn", usage },
      { t: "message_stop" },
    ]);

    const atBlockStop = observations.find((o) => o.after === "block_stop");
    expect(atBlockStop?.emitted.filter((t) => t === "ai_thinking_delta")).toHaveLength(2);
  });
});

describe("the durable record is unchanged by live emission", () => {
  it("persists the text once, with no delta rows", async () => {
    await runObserving(textTurn());

    const entries = store.projectionFrom(0);
    const texts = entries.filter((e) => e.type === "ai_text");
    expect(texts).toHaveLength(1);
    // Deltas are broadcast, never persisted: they carry no seq, so a stored row would sit
    // in the log with nothing to order it by.
    expect(entries.filter((e) => e.type.endsWith("_delta"))).toHaveLength(0);
  });

  it("leaves the emitted seq sequence gap-free", async () => {
    const { emitted } = await runObserving(textTurn());
    const seqs = emitted.filter((e) => e.seq !== null).map((e) => e.seq as number);

    // Deltas moving out of the turn batch must not disturb allocation — the normalizer is
    // the one allocator, and ephemerals never consume a number.
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_unused, i) => i + 1));
  });
});
