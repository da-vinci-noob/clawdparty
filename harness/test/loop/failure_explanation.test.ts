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
 * `run_failed.explanation` is null on the provider-error path, and the loop had the words in hand.
 *
 * Contract 1.12 added the field precisely because "the room saw 'run failed' and nothing else", and
 * `fail()` takes an optional `message` for it. The settle path passes one. The PROVIDER-ERROR path —
 * the most common way a run dies — calls `fail()` without it, so the fix reached the function and one
 * of its two callers.
 *
 * Measured live: a session whose default model was saved as `not-a-real-model` produced
 * `provider_error` carrying "400 The provided model identifier is invalid", immediately followed by
 * `run_failed` with `explanation: null`. Both events are persisted, so a reader could correlate them —
 * but the terminal event is what states why a run ended, and it stated nothing.
 */

const CAPS: Capabilities = {
  streaming: true,
  toolUse: true,
  toolUseWhileStreaming: true,
  contextWindow: 200_000,
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
  serverSideRefusalFallback: true,
  midConversationSystemMessages: true,
  midConversationToolChanges: true,
};

/** Rejects the request the way a provider does for a bad model id. */
class RejectingAdapter implements ProviderAdapter {
  readonly id = "rejecting";
  readonly displayName = "Rejecting provider";
  readonly entitlement: EntitlementPosture = {
    credentialKind: "api_key",
    thirdPartyClientPermitted: "yes",
    note: "test",
  };
  readonly failureHints = {
    expired: "expired hint",
    notEntitled: "entitlement hint",
    unreachable: "Could not reach the provider. Check network access",
  };

  async probe(): Promise<ProbeResult> {
    return { available: true, credentialSource: "env:ANTHROPIC_API_KEY" };
  }
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "real-model", displayName: "Real", capabilities: CAPS }];
  }
  capabilities(): Capabilities {
    return CAPS;
  }
  stream(): AsyncIterable<ProviderEvent> {
    throw Object.assign(new Error("400 The provided model identifier is invalid"), { status: 400 });
  }
}

let base: string;
let store: HarnessStoreApi;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "harness-explain-"));
  mkdirSync(join(base, "worktree"), { recursive: true });
  const opened = await openStore("77", { dir: join(base, "store"), owner: "explain" });
  if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
  store = opened.store;
});
afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

async function runRejected(): Promise<EventEnvelope[]> {
  const emitted: EventEnvelope[] = [];
  const loop = new RunLoop({
    store,
    adapter: new RejectingAdapter(),
    tools: new ToolRegistry(),
    emit: (batch) => emitted.push(...batch),
    now: () => 1_700_000_000_000,
    newId: () => "turn-1",
  });
  await loop.run({
    runId: "160",
    sessionId: "77",
    lane: "main",
    prompt: "hi",
    requestedBy: "7",
    model: "not-a-real-model",
    cwd: join(base, "worktree"),
    systemPrompt: "S",
    signal: new AbortController().signal,
  });
  return emitted;
}

describe("the terminal event says why the run died", () => {
  it("carries the provider's message as the explanation", async () => {
    const emitted = await runRejected();
    const failed = emitted.find((e) => e.type === "run_failed");

    expect(failed).toBeDefined();
    expect((failed?.payload as { explanation: string | null }).explanation).toMatch(
      /model identifier is invalid/,
    );
  });

  it("emits the provider_error too, so the remedy has somewhere to live", async () => {
    const emitted = await runRejected();
    const error = emitted.find((e) => e.type === "provider_error");

    // Both, not one instead of the other: the provider_error carries the classified remedy, the
    // terminal event carries why it ended. A reader of either should not need the other.
    expect(error).toBeDefined();
    // The classified remedy, not the adapter's connectivity hint: a 400 reached the provider.
    expect((error?.payload as { remedy: string }).remedy).not.toMatch(/check network access/i);
    expect((error?.payload as { remedy: string }).remedy).toMatch(/rejected|invalid/i);
  });
});
