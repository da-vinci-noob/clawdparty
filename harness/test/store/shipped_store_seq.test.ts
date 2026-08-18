import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@clawdparty/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Capabilities, ProviderAdapter, ProviderEvent } from "../../src/providers/contract.js";
import { openStore } from "../../src/store/store.js";
import { Supervisor } from "../../src/supervisor.js";
import { Transport } from "../../src/transport.js";

/**
 * Every durable event shipped to Rails carries ITS OWN entry's `store_seq` — the projection check
 * is the only thing that reads it, and it could never have passed.
 *
 * `ship()` stamped one value on the whole batch: `store.maxStoreSeq()`, read AFTER the commit. So
 * a two-event batch shipped the same number twice, and because the position marker is itself a row
 * the number was ahead of both entries by however many non-entry rows the commit wrote. Measured
 * live on session 78 with `bin/verify-projection`: Rails held
 * `[[2,"user_prompt",1],[2,"run_started",2],[3,"request_header",3],[6,"ai_thinking",4]]` where the
 * store held `[[1,...],[2,...],[3,...],[4,...]]` — matching counts, mismatched digest, reported as
 * `content_mismatch` with no hint that the numbers themselves were the problem.
 *
 * 's re-derivation reads `entriesFrom()` and matches on `store_seq`, so a wrong value here is
 * not cosmetic: it is the outage-recovery path silently unable to reconcile.
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
  serverSideCompaction: false,
  contextEditing: false,
  serverSideTools: { webSearch: false, webFetch: false, codeExecution: false },
  liveModelDiscovery: false,
  serverSideRefusalFallback: false,
  midConversationSystemMessages: true,
  midConversationToolChanges: true,
};

const adapter: ProviderAdapter = {
  id: "anthropic-direct",
  displayName: "stub",
  entitlement: { credentialKind: "api_key", thirdPartyClientPermitted: "yes", note: "" },
  probe: async () => ({ available: true, credentialSource: "env:ANTHROPIC_API_KEY" }),
  listModels: async () => [],
  capabilities: () => CAPS,
  async *stream(): AsyncIterable<ProviderEvent> {
    yield { t: "message_start", model: "m" };
    yield { t: "block_start", index: 0, kind: "thinking" };
    yield { t: "thinking_delta", index: 0, text: "mulling" };
    yield {
      t: "block_stop",
      index: 0,
      block: { type: "thinking", thinking: "mulling", signature: "sig" },
    };
    yield { t: "block_start", index: 1, kind: "text" };
    yield { t: "text_delta", index: 1, text: "done" };
    yield { t: "block_stop", index: 1, block: { type: "text", text: "done" } };
    yield {
      t: "message_delta",
      stopReason: "end_turn",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
    yield { t: "message_stop" };
  },
};

const shipped: EventEnvelope[] = [];
const TERMINAL = new Set(["run_finished", "run_failed", "run_interrupted"]);

let dir: string;
let cwd: string;
let supervisor: Supervisor;

beforeEach(() => {
  shipped.length = 0;
  dir = mkdtempSync(join(tmpdir(), "shipseq-store-"));
  cwd = mkdtempSync(join(tmpdir(), "shipseq-cwd-"));
  supervisor = new Supervisor(
    new Transport({
      railsInternalUrl: "http://rails:3000",
      sharedSecret: "s",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String((init as { body?: unknown }).body ?? "{}")) as {
          events?: EventEnvelope[];
        };
        shipped.push(...(body.events ?? []));
        return new Response("{}", { status: 200 });
      },
    }),
    { storeDir: dir, adapters: { "anthropic-direct": adapter } },
  );
});

afterEach(async () => {
  await supervisor.shutdown();
  rmSync(dir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

async function runOnce(): Promise<void> {
  await supervisor.startRun({
    run_id: "900",
    session_id: "78",
    prompt: "go",
    requested_by: "1",
    model: "m",
    repo_path: cwd,
    provider: "anthropic-direct",
  } as never);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (shipped.some((e) => TERMINAL.has(String(e.type)))) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("run did not settle");
}

describe("what Rails receives can re-derive the projection", () => {
  it("stamps each durable event with the position of its OWN entry", async () => {
    await runOnce();
    await supervisor.shutdown();

    const reopened = await openStore("78", { dir, owner: "assert" });
    if (!reopened.ok) throw new Error(`reopen failed: ${reopened.reason}`);
    const bySeq = new Map(reopened.store.entriesFrom(0).map((e) => [e.seq, e.store_seq]));
    reopened.store.close();

    const durable = shipped.filter((e) => e.seq !== null);
    expect(durable.length).toBeGreaterThan(3);
    for (const event of durable) {
      expect(
        event.store_seq,
        `${String(event.type)} (seq ${event.seq}) shipped ${event.store_seq}`,
      ).toBe(bySeq.get(event.seq as number));
    }
  });

  it("ships DISTINCT positions, since no two entries share one", async () => {
    await runOnce();

    const positions = shipped.filter((e) => e.seq !== null).map((e) => e.store_seq);
    expect(new Set(positions).size).toBe(positions.length);
  });
});
