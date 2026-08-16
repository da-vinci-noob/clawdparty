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
 * A run never CLAIMS to have been free.
 *
 * `run_finished` and `run_failed` carried a hardcoded `total_cost_usd: 0`, and Rails now copies
 * that figure onto `ai_runs.total_cost_usd` — so every run would have recorded a cost of exactly
 * zero. No provider here reports a price (Bedrock does not, and the harness computes none), so
 * the honest value is NULL: unknown, not free.
 *
 * This is the same rule `usageWrites` already applies to the ledger — "no report means unknown,
 * and the honest record of unknown is no row at all" — applied to the one field that was
 * violating it.
 */

const CAPS: Capabilities = {
  streaming: true,
  toolUse: true,
  toolUseWhileStreaming: true,
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  adaptiveThinking: false,
  thinkingDisplaySummarized: false,
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

class ScriptedAdapter implements ProviderAdapter {
  readonly id = "scripted";
  readonly displayName = "Scripted";
  readonly entitlement: EntitlementPosture = {
    credentialKind: "api_key",
    thirdPartyClientPermitted: "yes",
    note: "test",
  };

  constructor(private readonly events: ProviderEvent[]) {}

  async probe(): Promise<ProbeResult> {
    return { available: true, credentialSource: "env:ANTHROPIC_API_KEY" };
  }
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "m", displayName: "M", capabilities: CAPS }];
  }
  capabilities(): Capabilities {
    return CAPS;
  }
  async *stream(_req: ProviderRequest): AsyncIterable<ProviderEvent> {
    for (const event of this.events) yield event;
  }
}

const usage = {
  input_tokens: 100,
  output_tokens: 20,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

let base: string;
let store: HarnessStoreApi;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "harness-cost-"));
  mkdirSync(join(base, "worktree"), { recursive: true });
  const opened = await openStore("45", { dir: join(base, "store"), owner: "cost" });
  if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
  store = opened.store;
});
afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

async function run(events: ProviderEvent[]): Promise<EventEnvelope[]> {
  const emitted: EventEnvelope[] = [];
  const loop = new RunLoop({
    store,
    adapter: new ScriptedAdapter(events),
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

const terminal = (events: EventEnvelope[], type: string) =>
  events.find((e) => e.type === type)?.payload as Record<string, unknown> | undefined;

const textTurn: ProviderEvent[] = [
  { t: "message_start", model: "m" },
  { t: "block_start", index: 0, kind: "text" },
  { t: "text_delta", index: 0, text: "hi" },
  { t: "block_stop", index: 0, block: { type: "text", text: "hi" } },
  { t: "message_delta", stopReason: "end_turn", usage },
  { t: "message_stop" },
];

describe("run_finished", () => {
  it("reports cost as NULL, not zero, when nothing computed one", async () => {
    const payload = terminal(await run(textTurn), "run_finished");

    // The field is present and explicitly null. Omitting it entirely would also be honest, but
    // present-and-null says "we looked and do not know", which is the more useful record.
    expect(payload).toHaveProperty("total_cost_usd");
    expect(payload?.total_cost_usd).toBeNull();
  });

  it("still reports the usage the provider DID give", async () => {
    // Cost being unknown says nothing about tokens: those were reported and must survive.
    const payload = terminal(await run(textTurn), "run_finished");
    expect(payload?.usage).toMatchObject({ input_tokens: 100, output_tokens: 20 });
  });
});

describe("run_failed", () => {
  it("reports cost as NULL too", async () => {
    const failing: ProviderEvent[] = [
      { t: "message_start", model: "m" },
      { t: "message_delta", stopReason: "refusal", usage },
      { t: "message_stop" },
    ];
    const payload = terminal(await run(failing), "run_failed");

    expect(payload?.total_cost_usd).toBeNull();
  });
});
