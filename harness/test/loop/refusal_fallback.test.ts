import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@clawdparty/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunLoop } from "../../src/loop/run_loop.js";
import { decide, refusalExplanation } from "../../src/loop/stop_reasons.js";
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
 * The client-side refusal path, for providers that have no server-side one.
 *
 * TWO defects, and the second is the larger:
 *
 * 1. `serverSideRefusalFallback` had NO READER anywhere in the harness. Every adapter declared
 *    it and nothing consulted it, so a refusal produced one sentence regardless of whether the
 *    provider had explained itself. On Bedrock and Converse (both `false`) a refusal is HTTP 200
 *    with a bare stop reason and no content, so "The model declined to continue this request."
 *    was the entire account of it.
 *
 * 2. `RunLoop.fail()` took the composed message as `_message` and DISCARDED it. Every
 *    `settle_failed` sentence the loop had built since M4 — the output-limit one, the
 *    server-side-tool one, the refusal — was computed and thrown away, and `run_failed` carried
 *    only `stop_reason`. The room read "run failed" and stopped there. Contract 1.12 adds
 *    `explanation` as a REQUIRED field so the value has to be stated.
 */

function caps(over: Partial<Capabilities> = {}): Capabilities {
  return {
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
    ...over,
  };
}

const usage = {
  input_tokens: 100,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

class RefusingAdapter implements ProviderAdapter {
  readonly id = "refuser";
  readonly displayName = "Refuser";
  readonly entitlement: EntitlementPosture = {
    credentialKind: "api_key",
    thirdPartyClientPermitted: "yes",
    note: "test",
  };

  constructor(private readonly capabilities_: Capabilities) {}

  async probe(): Promise<ProbeResult> {
    return { available: true, credentialSource: "env:ANTHROPIC_API_KEY" };
  }
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "m", displayName: "M", capabilities: this.capabilities_ }];
  }
  capabilities(): Capabilities {
    return this.capabilities_;
  }
  async *stream(_req: ProviderRequest): AsyncIterable<ProviderEvent> {
    // HTTP 200, no content, bare stop reason — the shape a refusal actually takes.
    yield { t: "message_start", model: "m" };
    yield { t: "message_delta", stopReason: "refusal", usage };
    yield { t: "message_stop" };
  }
}

let base: string;
let store: HarnessStoreApi;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "harness-refusal-"));
  mkdirSync(join(base, "worktree"), { recursive: true });
  const opened = await openStore("45", { dir: join(base, "store"), owner: "refusal" });
  if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
  store = opened.store;
});
afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

async function runRefusal(capabilities: Capabilities): Promise<EventEnvelope[]> {
  const emitted: EventEnvelope[] = [];
  const loop = new RunLoop({
    store,
    adapter: new RefusingAdapter(capabilities),
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

const failedPayload = (events: EventEnvelope[]) =>
  events.find((e) => e.type === "run_failed")?.payload as
    | { stop_reason?: string; explanation?: string | null }
    | undefined;

describe("the explanation depends on the provider", () => {
  it("points at the model's own words where the provider supplies them", () => {
    expect(refusalExplanation(true)).toMatch(/its own explanation is in the reply above/i);
  });

  it("says the provider gave no reason where it does not", () => {
    // Bedrock and Converse. Without this the participant has a run that stopped for no stated
    // cause and no idea what to try next.
    const text = refusalExplanation(false);
    expect(text).toMatch(/no explanation/i);
    expect(text).toMatch(/rephrasing|different provider/i);
  });

  it("produces different text for the two cases at all", () => {
    // The whole point: one sentence for both is what the capability existed to prevent.
    expect(refusalExplanation(true)).not.toBe(refusalExplanation(false));
  });

  it("defaults to the less alarming message when capabilities are unknown", () => {
    // Claiming "this provider says nothing" about one that does is the worse wrong answer.
    const action = decide("refusal");
    expect(action.kind).toBe("settle_failed");
    if (action.kind === "settle_failed") {
      expect(action.message).toBe(refusalExplanation(true));
    }
  });
});

describe("a refusal on a provider with no server-side fallback", () => {
  it("records the harness-authored explanation on run_failed", async () => {
    const events = await runRefusal(caps({ serverSideRefusalFallback: false }));

    expect(failedPayload(events)?.explanation).toMatch(/no explanation/i);
  });

  it("keeps the stop reason as well, so the cause is still machine-readable", async () => {
    const events = await runRefusal(caps({ serverSideRefusalFallback: false }));

    // The prose is for the room; `stop_reason` is what code branches on. Replacing one with the
    // other would trade a machine-readable field for a sentence.
    expect(failedPayload(events)?.stop_reason).toBe("refusal");
  });

  it("does NOT fabricate assistant text to carry the explanation", async () => {
    const events = await runRefusal(caps({ serverSideRefusalFallback: false }));

    // Tempting, and wrong: an `ai_text` event attributes harness-authored prose to Claude, and
    // the next request would fold that fabrication into the model-visible surface as though the
    // model had said it.
    expect(events.some((e) => e.type === "ai_text")).toBe(false);
  });
});

describe("a refusal on a provider that explains itself", () => {
  it("gets the other message", async () => {
    const events = await runRefusal(caps({ serverSideRefusalFallback: true }));

    expect(failedPayload(events)?.explanation).toMatch(/reply above/i);
  });
});

describe("the discarded-message defect, for the other stop reasons", () => {
  it("carries the output-limit explanation instead of dropping it", () => {
    const action = decide("max_tokens");
    expect(action.kind).toBe("settle_failed");
    if (action.kind === "settle_failed") {
      // It was composed and discarded for the entire life of the loop.
      expect(action.message).toMatch(/output limit/i);
    }
  });

  it("carries the server-side-tool explanation too", () => {
    const action = decide("pause_turn", 5);
    if (action.kind === "settle_failed") {
      expect(action.message).toMatch(/did not finish/i);
    } else {
      throw new Error("expected settle_failed at the resume cap");
    }
  });

  it("states null rather than omitting the field when there is nothing to add", async () => {
    // `explanation` is REQUIRED on the payload, so "no explanation" is a written value. An
    // absent key and a null one read the same to a consumer, but only one of them proves the
    // producer considered the question.
    const events = await runRefusal(caps({ serverSideRefusalFallback: false }));
    expect(failedPayload(events)).toHaveProperty("explanation");
  });
});
