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
 * A model that cannot use tools AT ALL runs tool-less, or is refused. Never both.
 *
 * Measured on Bedrock: `deepseek.r1` answers `ValidationException: This model doesn't support
 * tool use` to a `toolConfig` on BOTH transports, so unlike the stream-while-using-tools case
 * there is no fallback an adapter could choose — the request either carries no tools or it
 * cannot be sent.
 *
 * The loop owns this one, and that is not a contradiction of the earlier removal of the loop's
 * `toolUseWhileStreaming` refusal. That field is about HOW to send a request, which is the
 * adapter's business. `toolUse: false` is about whether the request is coherent at all, which is
 * a precondition on the run — the same category as the `request:before` refusal next to it.
 *
 * Dropping the tools silently was rejected for the reason the streaming refusal gave: an agent
 * that cannot act will answer "I've updated the file" and update nothing. So the refusal names
 * the constraint, and the composer keeps a no-tools model out of that state by declaring no
 * tools for it.
 */

const BASE: Capabilities = {
  streaming: true,
  toolUse: true,
  toolUseWhileStreaming: true,
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  adaptiveThinking: false,
  thinkingBudgetTokens: null,
  thinkingDisplaySummarized: false,
  effortLevels: [],
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

const NO_TOOLS: Capabilities = { ...BASE, toolUse: false, toolUseWhileStreaming: false };

class ScriptedAdapter implements ProviderAdapter {
  readonly id = "scripted";
  readonly displayName = "Scripted";
  readonly entitlement: EntitlementPosture = {
    credentialKind: "api_key",
    thirdPartyClientPermitted: "yes",
    note: "test",
  };
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
    yield { t: "block_start", index: 0, kind: "thinking" };
    yield { t: "thinking_delta", index: 0, text: "let me work it out" };
    yield {
      t: "block_stop",
      index: 0,
      block: { reasoningContent: { reasoningText: { text: "let me work it out" } } },
    };
    yield { t: "block_start", index: 1, kind: "text" };
    yield { t: "text_delta", index: 1, text: "51" };
    yield { t: "block_stop", index: 1, block: { text: "51" } };
    yield {
      t: "message_delta",
      stopReason: "end_turn",
      usage: {
        input_tokens: 19,
        output_tokens: 208,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
    yield { t: "message_stop" };
  }
}

let base: string;
let cwd: string;
let store: HarnessStoreApi;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "harness-notools-"));
  cwd = join(base, "worktree");
  mkdirSync(cwd, { recursive: true });
  const opened = await openStore("45", { dir: join(base, "store"), owner: "notools" });
  if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
  store = opened.store;
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

async function run(
  caps: Capabilities,
  opts: { withTools: boolean; disallowed?: string[] },
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
    prompt: "What is 17 * 3?",
    requestedBy: "7",
    model: "m",
    cwd,
    systemPrompt: "S",
    ...(opts.disallowed ? { disallowedTools: opts.disallowed } : {}),
    signal: new AbortController().signal,
  });

  return { events, adapter, outcome: result.outcome };
}

describe("a no-tools model asked to answer, with no tools offered", () => {
  it("runs normally — this is the whole point of offering it", async () => {
    const { events, adapter, outcome } = await run(NO_TOOLS, { withTools: false });

    expect(outcome).toBe("finished");
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]?.tools).toEqual([]);
    expect(events.some((e) => e.type === "provider_error")).toBe(false);
  });

  it("echoes the withheld tools on run_started, so a late joiner can see the scope", async () => {
    // The feed's "no tools, answers only" note reads this. Without the echo, a run that CANNOT
    // act is indistinguishable from one that chose not to — and a late joiner has only the
    // backfilled events to go on.
    const { events } = await run(NO_TOOLS, { withTools: false, disallowed: ["bash", "read"] });
    const started = events.find((e) => e.type === "run_started");

    expect((started?.payload as { disallowed_tools?: string[] }).disallowed_tools).toEqual([
      "bash",
      "read",
    ]);
  });

  it("omits the echo entirely when nothing was withheld", async () => {
    const { events } = await run(BASE, { withTools: true });
    const started = events.find((e) => e.type === "run_started");

    // Omitted, not an empty array: "omitted means today's defaults" is the contract's reading.
    expect(started?.payload).not.toHaveProperty("disallowed_tools");
  });

  it("still streams its reasoning and its answer", async () => {
    // R1 puts most of a turn in reasoning content; a tool-less run must show both parts.
    const { events } = await run(NO_TOOLS, { withTools: false });

    expect(events.some((e) => e.type === "ai_thinking")).toBe(true);
    expect(events.filter((e) => e.type === "ai_text")).toHaveLength(1);
  });
});

describe("a no-tools model offered tools", () => {
  it("is refused, and the request is never sent", async () => {
    const { adapter, outcome } = await run(NO_TOOLS, { withTools: true });

    expect(outcome).toBe("failed");
    // Not sent: Bedrock's own answer is an opaque ValidationException, and the point of
    // declaring the capability is to fail before spending a request on a knowable limit.
    expect(adapter.sent).toHaveLength(0);
  });

  it("records WHY, so a restart can still explain the failure", async () => {
    // `run_failed` carries a stop reason and no explanation, so a provider_error that was only
    // emitted vanished on restart. The refusal persists its reason, reusing the earlier fix.
    const { events } = await run(NO_TOOLS, { withTools: true });

    const error = events.find((e) => e.type === "provider_error");
    const payload = error?.payload as { message?: string; remedy?: string } | undefined;
    expect(payload?.message).toMatch(/tool/i);
    expect(payload?.remedy).toBeTruthy();

    const persisted = store.entriesFrom(0).filter((e) => e.type === "provider_error");
    expect(persisted).toHaveLength(1);
  });
});

describe("a model that DOES use tools", () => {
  it("is unaffected — tools ride along as before", async () => {
    const { adapter, outcome } = await run(BASE, { withTools: true });

    expect(outcome).toBe("finished");
    expect(adapter.sent[0]?.tools.length).toBeGreaterThan(0);
  });
});
