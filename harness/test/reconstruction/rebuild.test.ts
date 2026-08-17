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
 * every request the harness sent can be rebuilt from the record alone.
 *
 * The rebuild goes through a store opened FRESH from the file, never the instance that
 * did the writing. A live store has caches, an open WAL, and in-memory state that the
 * writer populated: comparing against it proves the process agrees with itself, which is
 * true even when nothing was durably written. Reopening is what makes the record the
 * subject of the test.
 *
 * What "from the record alone" means precisely, since it is easy to over-claim: `model`,
 * `effort` and `provider` come from the record. The system prompt and tool schemas are
 * code-level constants the record fingerprints rather than copies — restating a system
 * prompt on every turn would dwarf the turns — and `reconstruct` REFUSES when a supplied
 * one does not match its digest. So a stale constant is an error, not a quietly different
 * request.
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
  effortLevels: ["low", "medium", "high", "xhigh", "max"],
  promptCaching: true,
  minCacheablePrefixTokens: 512,
  serverSideCompaction: false,
  contextEditing: false,
  serverSideTools: { webSearch: false, webFetch: false, codeExecution: false },
  liveModelDiscovery: true,
  serverSideRefusalFallback: true,
  midConversationSystemMessages: true,
  midConversationToolChanges: true,
};

const SYSTEM = "You are clawdparty.";

/** Captures every request it is handed, so the rebuild has something to be compared to. */
class RecordingAdapter implements ProviderAdapter {
  readonly id = "scripted";
  readonly displayName = "Scripted";
  readonly entitlement: EntitlementPosture = {
    credentialKind: "api_key",
    thirdPartyClientPermitted: "yes",
    note: "test",
  };
  readonly sent: ProviderRequest[] = [];
  /**
   * The log's high-water mark when each request went out — the END OF ITS PREFIX.
   *
   * Captured here because the RECORD does not mark it. A `request_header` pins the
   * boundary for the turn that emits one, but headers are emit-on-change, so an
   * unchanged turn has no marker and `usage.entry_store_seq` is written as NULL. So
   * rebuilding an INTERMEDIATE request needs the boundary supplied from outside the record
   * today.
   */
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

function turn(blocks: ProviderEvent[][], stopReason: "tool_use" | "end_turn"): ProviderEvent[] {
  return [
    { t: "message_start", model: "claude-opus-5" },
    ...blocks.flat(),
    {
      t: "message_delta",
      stopReason,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    { t: "message_stop" },
  ];
}

function text(index: number, body: string): ProviderEvent[] {
  return [
    { t: "block_start", index, kind: "text" },
    { t: "text_delta", index, text: body },
    { t: "block_stop", index, block: { type: "text", text: body } },
  ];
}

function thinking(index: number, body: string): ProviderEvent[] {
  return [
    { t: "block_start", index, kind: "thinking" },
    { t: "thinking_delta", index, text: body },
    { t: "block_stop", index, block: { type: "thinking", thinking: body, signature: "sig" } },
  ];
}

let base: string;
let dir: string;
let worktree: string;
let store: HarnessStoreApi;
let emitted: EventEnvelope[];

/** A store opened from the FILE, with the writer closed. */
async function reopen(): Promise<HarnessStoreApi> {
  await store.close();
  const again = await openStore("45", { dir, owner: "reader" });
  if (!again.ok) throw new Error(`reopen failed: ${again.reason}`);
  store = again.store;
  return again.store;
}

async function run(turns: ProviderEvent[][], effort?: "low" | "high") {
  const adapter = new RecordingAdapter(turns, () => store.maxStoreSeq());
  const loop = new RunLoop({
    store,
    adapter,
    tools: new ToolRegistry(),
    emit: (events) => emitted.push(...events),
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
    ...(effort ? { effort } : {}),
    signal: new AbortController().signal,
  });
  return adapter;
}

function rebuild(from: HarnessStoreApi, upTo?: number): request.ReconstructResult {
  const entries = from.entriesFrom(0);
  return request.reconstruct({
    entries: upTo === undefined ? entries : entries.filter((e) => e.store_seq <= upTo),
    systemPrompt: SYSTEM,
    tools: [],
    capabilities: CAPS,
    signal: new AbortController().signal,
  });
}

/** Compares everything but `signal`, which is live by contract and never equal. */
function comparable(req: ProviderRequest): string {
  const { signal: _signal, ...rest } = req;
  return JSON.stringify(rest);
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "harness-rebuild-"));
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

describe("a request rebuilds byte-for-byte from a REOPENED store", () => {
  it("reproduces the last request of a single-turn run", async () => {
    const adapter = await run([turn([text(0, "the fold is pure")], "end_turn")]);
    const sent = adapter.sent.at(-1);

    const result = rebuild(await reopen(), adapter.boundaries.at(-1));

    expect(result.ok, result.ok ? "" : `refused: ${result.reason}`).toBe(true);
    if (!result.ok) return;
    expect(comparable(result.request)).toBe(comparable(sent as ProviderRequest));
  });

  it("reproduces the SECOND request of a multi-turn run, which carries history", async () => {
    const adapter = await run([
      turn([thinking(0, "considering"), text(1, "first")], "end_turn"),
      turn([text(0, "second")], "end_turn"),
    ]);

    // The first request has an empty-ish surface, so it would pass even if the fold were
    // broken. The one that folds a prior assistant turn is the one worth comparing.
    const result = rebuild(await reopen(), adapter.boundaries.at(-1));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(comparable(result.request)).toBe(comparable(adapter.sent.at(-1) as ProviderRequest));
  });

  it("carries thinking blocks back VERBATIM, signature included", async () => {
    await run([turn([thinking(0, "considering"), text(1, "answer")], "end_turn")]);

    const result = rebuild(await reopen());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A rebuild that flattened blocks to text would still produce a plausible request and
    // then be REJECTED by the provider one turn later. `signature` is the tell.
    expect(JSON.stringify(result.request.messages)).toContain("signature");
  });

  it("takes the model from the RECORD, not from the caller's live config", async () => {
    await run([turn([text(0, "hi")], "end_turn")]);

    const result = rebuild(await reopen());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `reconstruct` is never told which model to use — reading it from live state would
    // describe the machine replaying the run rather than the run itself.
    expect(result.request.model).toBe("claude-opus-5");
  });

  it("recovers the run's EFFORT from the snapshot", async () => {
    const adapter = await run([turn([text(0, "hi")], "end_turn")], "high");

    const result = rebuild(await reopen(), adapter.boundaries.at(-1));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.effort).toBe("high");
    expect(comparable(result.request)).toBe(comparable(adapter.sent.at(-1) as ProviderRequest));
  });
});

describe("the prefix determines WHICH request comes back", () => {
  it("folding the WHOLE log yields the NEXT request, not the last one sent", async () => {
    const adapter = await run([turn([text(0, "answered")], "end_turn")]);

    const result = rebuild(await reopen());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Not a quirk — the log after a completed turn IS the state the next request would
    // fold, so it must contain the assistant reply that the last request produced.
    // Recorded because it looks like an off-by-one and a future reader may try to
    // "fix" it by trimming the prefix.
    expect(JSON.stringify(result.request.messages)).toContain("answered");
    expect(comparable(result.request)).not.toBe(comparable(adapter.sent.at(-1) as ProviderRequest));
  });
});

describe("it refuses rather than inventing a request", () => {
  it("refuses when the supplied system prompt is not the one the run used", async () => {
    await run([turn([text(0, "hi")], "end_turn")]);
    const entries = (await reopen()).entriesFrom(0);

    const result = request.reconstruct({
      entries,
      systemPrompt: "You are something else.",
      tools: [],
      capabilities: CAPS,
      signal: new AbortController().signal,
    });

    // Silently folding the wrong prompt is the failure this exists to prevent: the rebuilt
    // request would look right and describe a run that never happened.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("digest_mismatch");
    if (result.reason !== "digest_mismatch") return;
    expect(result.field).toBe("system_prompt");
    expect(result.recorded).not.toBe(result.supplied);
  });

  it("refuses when the tool schemas have changed since the run", async () => {
    await run([turn([text(0, "hi")], "end_turn")]);
    const entries = (await reopen()).entriesFrom(0);

    const result = request.reconstruct({
      entries,
      systemPrompt: SYSTEM,
      tools: [{ name: "bash" }],
      capabilities: CAPS,
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("digest_mismatch");
    if (result.reason !== "digest_mismatch") return;
    expect(result.field).toBe("tool_schemas");
  });

  it("refuses a prefix with no request_header at all", async () => {
    await run([turn([text(0, "hi")], "end_turn")]);
    const store2 = await reopen();

    // Everything before the first header: a real prefix, and one no request was ever built
    // from. Guessing a default model here would fabricate a request.
    const header = store2.entriesFrom(0).find((e) => e.type === "request_header");
    const result = rebuild(store2, (header?.store_seq ?? 1) - 1);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_snapshot");
  });
});

describe("one construction path, not two", () => {
  it("produces exactly what `build` produces for the same surface", async () => {
    await run([turn([text(0, "hi")], "end_turn")]);
    const store2 = await reopen();

    const viaReconstruct = rebuild(store2);
    const viaBuild = request.build({
      model: "claude-opus-5",
      capabilities: CAPS,
      systemPrompt: SYSTEM,
      tools: [],
      surface: store2.surfaceFrom(0),
      signal: new AbortController().signal,
    });

    // The point: reconstruction DELEGATES to `build` rather than re-implementing
    // the fold. A second implementation would drift the first time a cache rule or a
    // thinking default changed, and it would drift silently because both look reasonable.
    expect(viaReconstruct.ok).toBe(true);
    if (!viaReconstruct.ok) return;
    expect(comparable(viaReconstruct.request)).toBe(comparable(viaBuild));
  });

  it("rebuilds from the reopened store's surface, matching the live one", async () => {
    await run([turn([thinking(0, "t"), text(1, "hi")], "end_turn")]);
    const live = store.surfaceFrom(0);

    const reopened = (await reopen()).surfaceFrom(0);

    // If the surface did not survive the reopen, every comparison above would be against
    // an empty fold and would pass for the wrong reason.
    expect(reopened.length).toBeGreaterThan(0);
    expect(reopened.map((e) => e.type)).toEqual(live.map((e) => e.type));
  });
});
