import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@clawdparty/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMPACTION_BETA,
  COMPACTION_EDIT_TYPE,
  compactionDirective,
  isCompactionType,
} from "../../src/context/compaction.js";
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
 * a session driven past the window COMPLETES, and the compaction block is stored
 * verbatim.
 *
 * The defect this covers is not the loop's retry, which was already right:
 * `model_context_window_exceeded` maps to `{kind:"compact"}` and the loop goes round again. It is
 * that `ProviderRequest.compaction` was a setting NOTHING READ. `request_builder` set it whenever
 * the capability was true and no adapter translated it into a `context_management` directive, so
 * the retried request was identical to the one that had just overflowed — the loop would have
 * spun to `MAX_TURNS` having never once asked to be compacted.
 *
 * The live request path is unverified on this host (neither first-party Anthropic path is
 * available, and Bedrock declares no support), so the directive is asserted directly and the
 * request that carries it is asserted through a fake adapter. Everything after the request —
 * retry, verbatim storage, the event — runs through the real `RunLoop`.
 */

const WINDOW = 200_000;

function caps(over: Partial<Capabilities> = {}): Capabilities {
  return {
    streaming: true,
    toolUse: true,
    toolUseWhileStreaming: true,
    contextWindow: WINDOW,
    maxOutputTokens: 8_192,
    adaptiveThinking: false,
    thinkingBudgetTokens: null,
    thinkingDisplaySummarized: false,
    effortLevels: [],
    promptCaching: false,
    minCacheablePrefixTokens: null,
    serverSideCompaction: true,
    contextEditing: false,
    serverSideTools: { webSearch: false, webFetch: false, codeExecution: false },
    liveModelDiscovery: true,
    serverSideRefusalFallback: true,
    midConversationSystemMessages: true,
    midConversationToolChanges: true,
    ...over,
  };
}

const usage = {
  input_tokens: 195_000,
  output_tokens: 20,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/** The block the provider returns after compacting, in the shape the normalizer reads. */
const COMPACTION_BLOCK = {
  type: "compaction_20260112",
  summary: "Earlier turns: the participant asked for a README and Claude wrote one.",
  replaced_from_seq: 3,
  replaced_to_seq: 41,
  tokens_before: 195_000,
};

/** Turn 1 overflows; turn 2 comes back compacted and finishes. */
class OverflowThenCompactAdapter implements ProviderAdapter {
  readonly id = "scripted";
  readonly displayName = "Scripted";
  readonly entitlement: EntitlementPosture = {
    credentialKind: "api_key",
    thirdPartyClientPermitted: "yes",
    note: "test",
  };
  readonly seen: ProviderRequest[] = [];
  private turn = 0;

  constructor(private readonly capabilities_: Capabilities = caps()) {}

  async probe(): Promise<ProbeResult> {
    return { available: true, credentialSource: "env:ANTHROPIC_API_KEY" };
  }
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "m", displayName: "M", capabilities: this.capabilities_ }];
  }
  capabilities(): Capabilities {
    return this.capabilities_;
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.seen.push(req);
    this.turn += 1;
    if (this.turn === 1) {
      yield { t: "message_start", model: "m" };
      yield { t: "message_delta", stopReason: "model_context_window_exceeded", usage };
      yield { t: "message_stop" };
      return;
    }
    yield { t: "message_start", model: "m" };
    yield { t: "block_start", index: 0, kind: "compaction" };
    yield { t: "block_stop", index: 0, block: COMPACTION_BLOCK };
    yield { t: "block_start", index: 1, kind: "text" };
    yield { t: "block_stop", index: 1, block: { type: "text", text: "carrying on" } };
    yield { t: "message_delta", stopReason: "end_turn", usage };
    yield { t: "message_stop" };
  }
}

let base: string;
let store: HarnessStoreApi;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "harness-compaction-"));
  mkdirSync(join(base, "worktree"), { recursive: true });
  const opened = await openStore("45", { dir: join(base, "store"), owner: "compaction" });
  if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
  store = opened.store;
});
afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

async function run(adapter: ProviderAdapter): Promise<EventEnvelope[]> {
  const emitted: EventEnvelope[] = [];
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
    model: "m",
    cwd: join(base, "worktree"),
    systemPrompt: "S",
    signal: new AbortController().signal,
  });
  return emitted;
}

describe("the directive that was never sent", () => {
  it("asks for the edit type and its beta together", () => {
    // Sending one without the other is a 400, so they are produced as one value.
    expect(compactionDirective(caps(), true)).toEqual({
      context_management: { edits: [{ type: COMPACTION_EDIT_TYPE }] },
      betas: [COMPACTION_BETA],
    });
  });

  it("is withheld from a model that did not report the capability", () => {
    // The double-check that makes a stale request safe: asking a model that does not accept
    // `compact_20260112` fails the whole turn rather than degrading.
    expect(compactionDirective(caps({ serverSideCompaction: false }), true)).toBeUndefined();
  });

  it("is withheld when the request did not ask", () => {
    expect(compactionDirective(caps(), undefined)).toBeUndefined();
  });

  it("names the edit type the SDK names", () => {
    // `compact_20260112` is the key on the SDK's own ContextManagementCapability, sibling to
    // `clear_tool_uses_20250919`. A guessed name would gate on a field that is always undefined.
    expect(COMPACTION_EDIT_TYPE).toBe("compact_20260112");
  });
});

describe("a session driven past the window", () => {
  it("completes rather than failing", async () => {
    const events = await run(new OverflowThenCompactAdapter());

    // Before the directive was wired, the retried request was byte-identical to the one
    // that overflowed, so this run would have spun to MAX_TURNS and failed.
    expect(events.find((e) => e.type === "run_finished")).toBeDefined();
    expect(events.find((e) => e.type === "run_failed")).toBeUndefined();
  });

  it("asks for compaction on the request, not just after the overflow", async () => {
    const adapter = new OverflowThenCompactAdapter();
    await run(adapter);

    // Every request carries it while the capability is on — the point is that the FIRST one did,
    // because compaction is what prevents the overflow rather than a reaction to it.
    expect(adapter.seen[0]?.compaction).toBe(true);
  });

  it("records the compaction block VERBATIM, with its summary intact", async () => {
    await run(new OverflowThenCompactAdapter());

    const entries = store.entriesFrom(0);
    const stored = JSON.stringify(entries);
    // Flattening the block to text is what would break the NEXT request: the API needs this
    // block back unedited to know which history it may leave out (R6).
    expect(stored).toContain("compaction_20260112");
    expect(stored).toContain("the participant asked for a README");
  });

  it("emits context_compacted naming the span and the pre-compaction size", async () => {
    const events = await run(new OverflowThenCompactAdapter());
    const compacted = events.find((e) => e.type === "context_compacted");

    // "history was summarised" with no numbers gives a participant no sense of
    // what was lost.
    expect(compacted?.payload).toMatchObject({
      replaced_from_seq: 3,
      replaced_to_seq: 41,
      tokens_before: 195_000,
      summary_present: true,
    });
  });

  it("still delivers the assistant text from the compacted turn", async () => {
    const events = await run(new OverflowThenCompactAdapter());

    // A compaction turn is a normal turn that happens to include one more block.
    expect(events.some((e) => e.type === "ai_text")).toBe(true);
  });
});

describe("the block predicate", () => {
  it("recognises a compaction block whatever its version suffix", () => {
    // Versioned independently of the edit type requested, so this must not be an equality check
    // against `COMPACTION_EDIT_TYPE` — an unrecognised compaction block is dropped history.
    for (const type of ["compaction", "compaction_20260112", "compaction_20270601"]) {
      expect(isCompactionType(type), type).toBe(true);
    }
  });

  it("does not mistake other block types for it", () => {
    for (const type of ["text", "thinking", "redacted_thinking", "tool_use", "compact"]) {
      expect(isCompactionType(type), type).toBe(false);
    }
  });
});
