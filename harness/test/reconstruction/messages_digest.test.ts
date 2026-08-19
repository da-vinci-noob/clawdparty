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
  ProviderRequest,
} from "../../src/providers/contract.js";
import { openStore } from "../../src/store/store.js";
import type { HarnessStoreApi } from "../../src/store/types.js";
import { ToolRegistry } from "../../src/tools/registry.js";

/**
 * 's LIVE half: the record can now say whether a rebuilt request is the one that was
 * sent, on a session nobody scripted.
 *
 * `rebuild.test.ts` proves the fold byte-for-byte, but only because its scripted adapter keeps every
 * `ProviderRequest` it was handed. Nothing did that for a real session, and the manual walkthrough
 * told a reader to `diff` against `/tmp/actual-requests.jsonl` — a file no script in this repo
 * writes. So the manual half of  had no comparison side at all.
 *
 * `request_header` already fingerprints the two things the record does not copy (system prompt, tool
 * schemas) so a stale supplied one is REFUSED rather than silently folded. `messages_digest` covers
 * the part the fold produces.
 *
 * TWO THINGS THAT MADE THE FIRST ATTEMPT WRONG, both pinned below.
 *
 * 1. The snapshot is FINGERPRINTED for emit-on-change, and the messages array grows every turn — so
 *    including the digest in that fingerprint forces a header on every single request, which is
 *    exactly what the emit-on-change comment warns against ("20 identical events in a 20-turn run").
 *    Measured: it failed `behaviour_parity.test.ts`. The digest therefore rides on the payload and is
 *    excluded from change detection.
 *
 * 2. `latestSnapshot` folds headers FORWARD, so a prefix longer than the turn that emitted the header
 *    would compare today's rebuild against an older turn's digest and report a false mismatch. The
 *    verdict is only meaningful when the prefix ENDS at that header's request, so any other prefix
 *    reports `not_at_boundary` rather than a verdict it cannot support.
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
  effortLevels: ["low", "high"],
  promptCaching: false,
  minCacheablePrefixTokens: null,
  serverSideCompaction: false,
  contextEditing: false,
  serverSideTools: { webSearch: false, webFetch: false, codeExecution: false },
  liveModelDiscovery: true,
  serverSideRefusalFallback: false,
  midConversationSystemMessages: true,
  midConversationToolChanges: true,
};

const SYSTEM = "You are clawdparty.";

/** Two turns, so emit-on-change has something to be wrong about. */
class Adapter implements ProviderAdapter {
  readonly id = "scripted";
  readonly displayName = "Scripted";
  readonly entitlement: EntitlementPosture = {
    credentialKind: "api_key",
    thirdPartyClientPermitted: "yes",
    note: "test",
  };
  readonly sent: ProviderRequest[] = [];
  private turn = 0;

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
    const first = this.turn++ === 0;
    yield { t: "message_start", model: "claude-opus-5" };
    if (first) {
      // A tool call, so the second turn has a genuinely longer messages array.
      yield { t: "block_start", index: 0, kind: "tool_use" };
      yield {
        t: "block_stop",
        index: 0,
        block: { type: "tool_use", id: "t1", name: "noop", input: {} },
      };
      yield {
        t: "message_delta",
        stopReason: "tool_use",
        usage: {
          input_tokens: 5,
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
          input_tokens: 9,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
    }
    yield { t: "message_stop" };
  }
}

let dir: string;
let worktree: string;
let store: HarnessStoreApi;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "msgdigest-store-"));
  worktree = mkdtempSync(join(tmpdir(), "msgdigest-cwd-"));
  mkdirSync(worktree, { recursive: true });
  const opened = await openStore("46", { dir, owner: "writer" });
  if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
  store = opened.store;
});
afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(worktree, { recursive: true, force: true });
});

async function runOnce(): Promise<Adapter> {
  const adapter = new Adapter();
  const loop = new RunLoop({
    store,
    adapter,
    tools: new ToolRegistry(),
    emit: () => {},
    now: () => 1_700_000_000_000,
    newId: () => "turn-1",
  });
  await loop.run({
    runId: "1",
    sessionId: "46",
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

async function reopen(): Promise<HarnessStoreApi> {
  await store.close();
  const again = await openStore("46", { dir, owner: "reader" });
  if (!again.ok) throw new Error(`reopen failed: ${again.reason}`);
  store = again.store;
  return again.store;
}

const rebuildAt = (entries: ReturnType<HarnessStoreApi["entriesFrom"]>) =>
  request.reconstruct({
    entries,
    systemPrompt: SYSTEM,
    tools: [],
    capabilities: CAPS,
    signal: new AbortController().signal,
  });

describe("the record fingerprints the messages it folded", () => {
  it("writes a messages_digest on request_header", async () => {
    await runOnce();
    const header = (await reopen()).entriesFrom(0).find((e) => e.type === "request_header");

    expect(header).toBeDefined();
    expect((header?.payload as { messages_digest?: string }).messages_digest).toBeTruthy();
  });

  it("records the digest of what was ACTUALLY sent", async () => {
    const adapter = await runOnce();
    const header = (await reopen()).entriesFrom(0).find((e) => e.type === "request_header");

    const sent = adapter.sent[0];
    if (!sent) throw new Error("nothing sent");
    expect((header?.payload as { messages_digest?: string }).messages_digest).toBe(
      request.digest(JSON.stringify(sent.messages)),
    );
  });

  it("reports MATCH for the prefix that ends at the header's request", async () => {
    await runOnce();
    const entries = (await reopen()).entriesFrom(0);
    const header = entries.find((e) => e.type === "request_header");
    if (!header) throw new Error("no header");
    const prefix = entries.filter((e) => e.store_seq <= header.store_seq);

    const result = rebuildAt(prefix);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages.status).toBe("match");
  });

  it("reports NOT_AT_BOUNDARY for a longer prefix, instead of a false mismatch", async () => {
    await runOnce();
    const entries = (await reopen()).entriesFrom(0);

    // The full log rebuilds the request the session would send NEXT — a legitimate thing
    // `scripts/reconstruct.ts` deliberately emits. Comparing it to the first header's digest would
    // report a mismatch that means nothing.
    const result = rebuildAt(entries);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages.status).toBe("not_at_boundary");
  });

  it("reports MISMATCH when the record no longer implies what was sent", async () => {
    await runOnce();
    const entries = (await reopen()).entriesFrom(0);
    const header = entries.find((e) => e.type === "request_header");
    if (!header) throw new Error("no header");
    // Drop the prompt but keep the boundary: the fold now produces a shorter conversation than the
    // one that went out, which is the "record is insufficient" failure a digest exists to surface.
    const prefix = entries.filter(
      (e) => e.store_seq <= header.store_seq && e.type !== "user_prompt",
    );

    const result = rebuildAt(prefix);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages.status).toBe("mismatch");
  });

  it("says UNRECORDED, not match, for a header written before the field existed", async () => {
    await runOnce();
    const entries = (await reopen()).entriesFrom(0);
    const header = entries.find((e) => e.type === "request_header");
    if (!header) throw new Error("no header");
    const prefix = entries
      .filter((e) => e.store_seq <= header.store_seq)
      .map((entry) => {
        if (entry.type !== "request_header") return entry;
        const { messages_digest: _gone, ...rest } = entry.payload as Record<string, unknown>;
        return { ...entry, payload: rest };
      });

    const result = rebuildAt(prefix);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Reporting "match" here would be the can't-fail shape: every session written before 1.16 would
    // claim a verification it never received.
    expect(result.messages.status).toBe("unrecorded");
  });
});

describe("emit-on-change survives the new field", () => {
  it("emits ONE header for a two-turn run whose configuration never changed", async () => {
    // The whole reason the first attempt was reverted. The messages array grows every turn, so a
    // digest inside the change-detection fingerprint makes every turn look like a new configuration.
    const adapter = await runOnce();
    expect(adapter.sent.length).toBe(2);

    const headers = (await reopen()).entriesFrom(0).filter((e) => e.type === "request_header");
    expect(headers).toHaveLength(1);
  });
});
