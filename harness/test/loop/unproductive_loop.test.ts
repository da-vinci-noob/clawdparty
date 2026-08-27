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
} from "../../src/providers/contract.js";
import { openStore } from "../../src/store/store.js";
import type { HarnessStoreApi } from "../../src/store/types.js";
import { ToolRegistry } from "../../src/tools/registry.js";

/**
 * A model that repeats an IDENTICAL failing tool call must not be allowed to spend the whole run on
 * it. Measured on the live stack before this existed: `us.meta.llama3-1-8b` called `read("stdout")`,
 * got "stdout is not available", and repeated it **52 times in 90 seconds** — no text, no terminal
 * event, the run still `running`, and `MAX_TURNS = 100` the only thing that would ever stop it
 * (~180s and 100 paid requests away).
 *
 * That is what the owner was actually seeing when they reported "I have to refresh the page to see
 * the response". There was no response. The realtime path was fine the whole time — two subscribers
 * measured at +84ms, identical to the millisecond — so the visible symptom and the cause were in
 * different subsystems, which is why the report pointed at the wrong one.
 *
 * The cap is a BACKSTOP, not a detector. A backstop that costs 100 requests and three minutes before
 * it fires is indistinguishable from a hang, and the run's own record shows the reason plainly:
 * the same `(tool, input)` failing over and over. Nothing was reading it.
 *
 * Identical INPUT is the signal, not merely a repeated failure. A model retrying with a corrected
 * path is making progress and must be left alone; sending the same bytes and getting the same error
 * is not.
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

/**
 * Asks for the same `read` of the same path on every turn, exactly as the measured llama run did.
 * `varyInput` makes it a DIFFERENT path each turn, which is the progress case that must survive.
 */
class LoopingAdapter implements ProviderAdapter {
  readonly id = "anthropic-direct";
  readonly displayName = "Looping";
  readonly entitlement: EntitlementPosture = {
    credentialKind: "api_key",
    thirdPartyClientPermitted: "yes",
    note: "test",
  };
  turns = 0;

  constructor(private readonly varyInput = false) {}

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
    const path = this.varyInput ? `missing-${this.turns}.txt` : "stdout";
    yield { t: "message_start", model: "m" };
    yield { t: "block_start", index: 0, kind: "tool_use" };
    yield {
      t: "block_stop",
      index: 0,
      block: {
        type: "tool_use",
        id: `call-${this.turns}`,
        name: "read",
        input: { path },
      },
    };
    yield {
      t: "message_delta",
      stopReason: "tool_use",
      usage: {
        input_tokens: 10,
        output_tokens: 2,
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
  dir = mkdtempSync(join(tmpdir(), "loopguard-store-"));
  cwd = mkdtempSync(join(tmpdir(), "loopguard-cwd-"));
  mkdirSync(cwd, { recursive: true });
  const opened = await openStore("60", { dir, owner: "loop" });
  if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
  store = opened.store;
});
afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

async function run(adapter: ProviderAdapter): Promise<EventEnvelope[]> {
  const emitted: EventEnvelope[] = [];
  const loop = new RunLoop({
    store,
    adapter,
    tools: new ToolRegistry(),
    emit: (batch) => emitted.push(...batch),
    now: () => 1_700_000_000_000,
    newId: () => "turn",
  });
  await loop.run({
    runId: "1",
    sessionId: "60",
    lane: "main",
    prompt: "read stdout",
    requestedBy: "7",
    model: "m",
    cwd,
    systemPrompt: "S",
    signal: new AbortController().signal,
  });
  return emitted;
}

describe("a repeated identical tool failure stops the run", () => {
  it("terminates in a handful of turns, not 100", async () => {
    const adapter = new LoopingAdapter();

    await run(adapter);

    // The measured run reached 52 repeats and would have run to 100. A guard that only fires near
    // the cap is the same defect with extra steps.
    expect(adapter.turns).toBeLessThanOrEqual(5);
    expect(adapter.turns).toBeGreaterThan(1);
  });

  it("reaches a TERMINAL state rather than hanging", async () => {
    const emitted = await run(new LoopingAdapter());

    const terminal = emitted.filter((e) =>
      ["run_finished", "run_failed", "run_interrupted"].includes(String(e.type)),
    );
    expect(terminal).toHaveLength(1);
  });

  it("names the tool and the error, so the reason is readable without the record", async () => {
    const emitted = await run(new LoopingAdapter());
    const failed = emitted.find((e) => e.type === "run_failed");

    expect(failed).toBeDefined();
    const explanation = String((failed?.payload as { explanation?: string }).explanation ?? "");
    // "exceeded 100 turns" told the reader nothing about WHY. This has to name the call.
    expect(explanation).toMatch(/read/);
    expect(explanation).toMatch(/same|repeat|identical/i);
  });

  it("does NOT stop a model that varies its input, which is progress", async () => {
    // The distinction that makes the guard safe: a different path each turn is a model working a
    // problem, and it must be allowed to continue to the ordinary cap.
    const adapter = new LoopingAdapter(true);

    await run(adapter);

    expect(adapter.turns).toBeGreaterThan(5);
  });
});
