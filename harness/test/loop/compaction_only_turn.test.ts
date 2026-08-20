import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
} from "../../src/providers/contract.js";
import { openStore } from "../../src/store/store.js";
import type { HarnessStoreApi } from "../../src/store/types.js";
import { ToolRegistry } from "../../src/tools/registry.js";

/**
 * A turn whose ONLY content is a compaction block must still put that block on the surface.
 *
 * A turn's verbatim blocks ride on its first CLAUDE-actored entry (the `blockCarrier`), and
 * `context_compacted` is SYSTEM-actored. So a compaction-only turn had no carrier at all: the block
 * reached the surface nowhere, and the next request re-sent the whole span the provider had just
 * told us it replaced — the exact history the compaction existed to remove, at full token cost, on
 * a session that had already run out of window.
 *
 * THE ROLE QUESTION IS NOW ANSWERED, and it is why this change waited. Folding a system-actored
 * entry places the block in a USER message, and the design record refused to guess which role the
 * API expects because "guessing produces a request that looks right and is wrong". Measured against
 * the live API (claude-opus-5 over the host login, once that path became usable):
 *
 *   compaction block in an ASSISTANT message → 200
 *   compaction block in a USER message       → 200, identical input_tokens
 *
 * and the API's own block-type enumeration lists `compaction` as valid in both roles. So the user
 * placement carries no 400 risk. Semantic equivalence is NOT claimed — only that the API accepts
 * both, which is what removes the hazard that blocked this.
 *
 * Also pinned by the same probe, discharging this module's "the live path is UNVERIFIED" caveat:
 * `context_management: { edits: [{ type: "compact_20260112" }] }` with beta `compact-2026-01-12`
 * returns 200; without the beta it is a 400 ("context_management: Extra inputs are not permitted");
 * and the API enumerates exactly `clear_tool_uses_20250919` and `compact_20260112`.
 */

const CAPS: Capabilities = {
  streaming: true,
  toolUse: true,
  toolUseWhileStreaming: true,
  contextWindow: 200_000,
  maxOutputTokens: 8192,
  adaptiveThinking: false,
  thinkingBudgetTokens: null,
  thinkingDisplaySummarized: false,
  effortLevels: [],
  promptCaching: false,
  minCacheablePrefixTokens: null,
  serverSideCompaction: true,
  contextEditing: true,
  serverSideTools: { webSearch: false, webFetch: false, codeExecution: false },
  liveModelDiscovery: false,
  serverSideRefusalFallback: false,
  midConversationSystemMessages: true,
  midConversationToolChanges: true,
};

const COMPACTION_BLOCK = {
  type: "compaction",
  summary: "Earlier the user asked about rebases; that exchange is summarised here.",
  replaced_from_seq: 2,
  replaced_to_seq: 40,
  tokens_before: 190_000,
};

/** Turn 1 returns ONLY a compaction block. Turn 2 ends the run, so the fold can be inspected. */
class CompactingAdapter implements ProviderAdapter {
  readonly id = "anthropic-direct";
  readonly displayName = "Compacting";
  readonly entitlement: EntitlementPosture = {
    credentialKind: "api_key",
    thirdPartyClientPermitted: "yes",
    note: "test",
  };
  turns = 0;

  async probe(): Promise<ProbeResult> {
    return { available: true, credentialSource: "env:ANTHROPIC_API_KEY" };
  }
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "m", displayName: "M", capabilities: CAPS }];
  }
  capabilities(): Capabilities {
    return CAPS;
  }
  async *stream(): AsyncIterable<ProviderEvent> {
    this.turns += 1;
    yield { t: "message_start", model: "m" };
    if (this.turns === 1) {
      yield { t: "block_start", index: 0, kind: "compaction" };
      yield { t: "block_stop", index: 0, block: COMPACTION_BLOCK };
      // `tool_use` so the loop takes another turn and we can see the NEXT request's fold.
      yield { t: "block_start", index: 1, kind: "tool_use" };
      yield {
        t: "block_stop",
        index: 1,
        block: { type: "tool_use", id: "c1", name: "read", input: { path: "a.txt" } },
      };
      yield {
        t: "message_delta",
        stopReason: "tool_use",
        usage: {
          input_tokens: 9,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
    } else {
      yield { t: "block_start", index: 0, kind: "text" };
      yield { t: "text_delta", index: 0, text: "done" };
      yield { t: "block_stop", index: 0, block: { type: "text", text: "done" } };
      yield {
        t: "message_delta",
        stopReason: "end_turn",
        usage: {
          input_tokens: 11,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
    }
    yield { t: "message_stop" };
  }
}

/** Compaction ALONE — no tool_use, no text. The pure case the carrier had no answer for. */
class CompactionOnlyAdapter extends CompactingAdapter {
  async *stream(): AsyncIterable<ProviderEvent> {
    this.turns += 1;
    yield { t: "message_start", model: "m" };
    yield { t: "block_start", index: 0, kind: "compaction" };
    yield { t: "block_stop", index: 0, block: COMPACTION_BLOCK };
    yield {
      t: "message_delta",
      stopReason: "end_turn",
      usage: {
        input_tokens: 9,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
    yield { t: "message_stop" };
  }
}

let dir: string;
let cwd: string;
let store: HarnessStoreApi;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "compactonly-store-"));
  cwd = mkdtempSync(join(tmpdir(), "compactonly-cwd-"));
  mkdirSync(cwd, { recursive: true });
  const opened = await openStore("70", { dir, owner: "compact" });
  if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
  store = opened.store;
});
afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

async function run(adapter: ProviderAdapter): Promise<void> {
  const loop = new RunLoop({
    store,
    adapter,
    tools: new ToolRegistry(),
    emit: () => {},
    now: () => 1_700_000_000_000,
    newId: () => "turn",
  });
  await loop.run({
    runId: "1",
    sessionId: "70",
    lane: "main",
    prompt: "carry on",
    requestedBy: "7",
    model: "m",
    cwd,
    systemPrompt: "S",
    signal: new AbortController().signal,
  });
}

const surfaceBlocks = (s: HarnessStoreApi): unknown[] =>
  s.surfaceFrom(0).flatMap((e) => (Array.isArray(e.blocks) ? (e.blocks as unknown[]) : []));

describe("a compaction block reaches the surface", () => {
  it("carries the block when the turn ALSO produced a tool call", async () => {
    await run(new CompactingAdapter());

    const compaction = surfaceBlocks(store).filter(
      (b) => (b as { type?: string }).type === "compaction",
    );
    expect(compaction).toHaveLength(1);
    expect(compaction[0]).toEqual(COMPACTION_BLOCK);
  });

  it("carries it on a COMPACTION-ONLY turn, which had no carrier at all", async () => {
    await run(new CompactionOnlyAdapter());

    const compaction = surfaceBlocks(store).filter(
      (b) => (b as { type?: string }).type === "compaction",
    );
    // Was zero: `context_compacted` is system-actored, so `blockCarrier` returned -1 and the block
    // was dropped — taking the provider's summary with it.
    expect(compaction).toHaveLength(1);
    expect(compaction[0]).toEqual(COMPACTION_BLOCK);
  });

  it("carries the compaction block on EXACTLY ONE entry", async () => {
    // The other half of the carrier fix: a duplicated carrier re-sends the turn's content on every later
    // request, and byte-comparing a rebuilt request against the sent one cannot see it.
    //
    // Scoped to entries carrying the COMPACTION block. An earlier version counted every surface
    // entry with a `blocks` array and passed before the fix for the wrong reason — `user_prompt`
    // carries its own blocks, so the count was 1 while the compaction block was on nothing.
    await run(new CompactionOnlyAdapter());

    const carrying = store
      .surfaceFrom(0)
      .filter((e) =>
        (Array.isArray(e.blocks) ? (e.blocks as Array<{ type?: string }>) : []).some(
          (b) => b.type === "compaction",
        ),
      );
    expect(carrying).toHaveLength(1);
    expect(carrying[0]?.type).toBe("context_compacted");
  });

  it("puts the block into the next request's fold, which is the whole point", async () => {
    await run(new CompactionOnlyAdapter());

    const rebuilt = request.reconstruct({
      entries: store.entriesFrom(0),
      systemPrompt: "S",
      tools: [],
      capabilities: CAPS,
      signal: new AbortController().signal,
    });

    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    const folded = JSON.stringify(rebuilt.request.messages);
    // Without this the next request re-sent the span the provider said it had replaced — at full
    // token cost, on a session that had already exhausted its window.
    expect(folded).toContain("compaction");
    expect(folded).toContain("summarised here");
  });
});
