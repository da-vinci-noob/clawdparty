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
import * as read from "../../src/tools/read.js";
import { ToolRegistry } from "../../src/tools/registry.js";

/**
 * A model that cannot stream WHILE using tools must fail loudly, not quietly.
 *
 * Measured on Bedrock: 8 of 18 text-capable non-Anthropic models refuse a `toolConfig` on
 * `ConverseStream` with "This model doesn't support tool use in streaming mode" while
 * accepting it on `Converse` — every Llama, Mistral Pixtral, and both Writer Palmyra models.
 * The contract could not express that at all (`streaming` and `toolUse` are literal `true`),
 * so v1.6 adds `toolUseWhileStreaming`.
 *
 * The two silent failures this guards against, both of which look like a product bug rather
 * than a capability limit:
 *
 *   dropping tools   an agent that answers "I would edit that file" and edits nothing
 *   dropping deltas  the feed shows a spinner for the whole turn, which is exactly the defect
 *                    that was just removed
 *
 * Until the non-streaming fallback lands, the loop REFUSES the turn and names the constraint. A
 * refusal a participant can read beats either silence.
 */

const BASE: Capabilities = {
  streaming: true,
  toolUse: true,
  toolUseWhileStreaming: true,
  contextWindow: 1_000_000,
  maxOutputTokens: 64_000,
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
  /** Every request the loop actually sent — how we prove tools were not silently dropped. */
  readonly sent: ProviderRequest[] = [];

  constructor(private readonly caps: Capabilities) {}

  async probe(): Promise<ProbeResult> {
    return { available: true, credentialSource: "env:ANTHROPIC_API_KEY" };
  }
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "m", displayName: "M", capabilities: this.caps }];
  }
  capabilities(): Capabilities {
    return this.caps;
  }
  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.sent.push(req);
    yield { t: "message_start", model: "m" };
    yield { t: "block_start", index: 0, kind: "text" };
    yield { t: "text_delta", index: 0, text: "hello" };
    yield { t: "block_stop", index: 0, block: { type: "text", text: "hello" } };
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
  }
}

let base: string;
let worktree: string;
let store: HarnessStoreApi;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "harness-tuws-"));
  worktree = join(base, "worktree");
  mkdirSync(worktree, { recursive: true });
  const opened = await openStore("45", { dir: join(base, "store"), owner: "tuws" });
  if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
  store = opened.store;
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

async function run(
  caps: Capabilities,
  opts: { withTools: boolean } = { withTools: true },
): Promise<{ events: EventEnvelope[]; adapter: ScriptedAdapter; outcome: string }> {
  const events: EventEnvelope[] = [];
  const adapter = new ScriptedAdapter(caps);
  const tools = new ToolRegistry();
  if (opts.withTools) tools.register(read.definition);

  const loop = new RunLoop({
    store,
    adapter,
    tools,
    emit: (batch) => events.push(...batch),
    now: () => 1_700_000_000_000,
    newId: () => "turn-1",
  });

  const result = await loop.run({
    runId: "1",
    sessionId: "45",
    lane: "main",
    prompt: "P",
    requestedBy: "7",
    model: "m",
    cwd: worktree,
    systemPrompt: "S",
    signal: new AbortController().signal,
  });

  return { events, adapter, outcome: result.outcome };
}

describe("a model that streams AND uses tools", () => {
  it("runs normally", async () => {
    const { events, adapter, outcome } = await run(BASE);

    expect(outcome).toBe("finished");
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]?.tools.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "ai_text_delta")).toBe(true);
  });
});

describe("a model that cannot use tools WHILE streaming is NOT refused by the loop", () => {
  const limited: Capabilities = { ...BASE, toolUseWhileStreaming: false };

  it("does not refuse a tools turn — the ADAPTER owns how it serves it", async () => {
    // An interim loop-level refusal shipped first and was then removed, because bedrock-converse
    // now transparently falls back to non-streaming Converse for these models. The loop is
    // provider-neutral and must NOT reason about toolUseWhileStreaming: it hands the request to
    // the adapter, which decides stream-vs-not. This scripted adapter streams regardless, and
    // the loop lets it.
    const { adapter, outcome } = await run(limited);

    expect(outcome).toBe("finished");
    expect(adapter.sent).toHaveLength(1);
  });

  it("emits no provider_error for the capability — it is not an error", async () => {
    const { events } = await run(limited);
    // The old refusal wrote a provider_error naming the limit. There is nothing to name now:
    // the adapter handles it, so a clean run has no error at all.
    expect(events.some((e) => e.type === "provider_error")).toBe(false);
  });

  it("still runs when no tools are offered at all", async () => {
    const { events, adapter, outcome } = await run(limited, { withTools: false });

    expect(outcome).toBe("finished");
    expect(adapter.sent).toHaveLength(1);
    expect(events.some((e) => e.type === "ai_text_delta")).toBe(true);
  });
});
