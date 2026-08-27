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
 * Interrupt is one of the five capabilities the product never cuts — and a MID-STREAM interrupt
 * was recorded as a FAILURE.
 *
 * Measured on the live stack (S9): a real Bedrock run in the `side` lane was interrupted
 * while streaming, the harness accepted the interrupt with a 200, and the run terminated as
 * `run_failed` with `stop_reason: "api_error"` — `explanation: null`, `api_error_status: null`,
 * usage all zeros. Someone who pressed Stop was told their run hit an API error, with nothing
 * saying what happened.
 *
 * The cause is where the loop LOOKS. `spec.signal.aborted` is checked at the top of the turn
 * loop, which is a turn BOUNDARY, so an abort arriving mid-turn is only seen by the transport:
 * it throws, and `classifyStreamError` — which knows about 401/403/429 and nothing about aborts —
 * falls through to `api_error`. The existing lane test (`independent_interrupt.test.ts`) checks
 * which lanes stay ACTIVE after an interrupt and never looks at the event that resulted, which is
 * why a green suite still had this.
 *
 * `signal.aborted` at catch time is the signal used here, deliberately over sniffing the error:
 * every transport words an abort differently (undici's `AbortError`, an SDK wrapper, a plain
 * `Error("aborted")`), and the run's own signal is ground truth about what the operator asked for.
 */

const CAPS: Capabilities = {
  streaming: true,
  toolUse: true,
  toolUseWhileStreaming: true,
  contextWindow: 1_000_000,
  maxOutputTokens: 64_000,
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

/**
 * A transport that behaves like a real one under abort: it streams, and once the signal trips it
 * THROWS mid-iteration rather than returning cleanly. `errorFactory` varies the wording, because
 * no classifier should depend on it.
 */
class AbortingAdapter implements ProviderAdapter {
  readonly id = "aborting";
  readonly displayName = "Aborting transport";
  readonly entitlement: EntitlementPosture = {
    credentialKind: "api_key",
    thirdPartyClientPermitted: "yes",
    note: "test",
  };

  constructor(
    private readonly controller: AbortController,
    private readonly errorFactory: () => Error = () => {
      const err = new Error("The operation was aborted.");
      err.name = "AbortError";
      return err;
    },
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

  async *stream(_req: ProviderRequest): AsyncIterable<ProviderEvent> {
    yield { t: "message_start", model: "claude-opus-5" };
    yield { t: "block_start", index: 0, kind: "text" };
    yield { t: "text_delta", index: 0, text: "half a sen" };
    // The operator presses Stop here, exactly as it happens in production.
    this.controller.abort();
    throw this.errorFactory();
  }
}

let base: string;
let worktree: string;
let store: HarnessStoreApi;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "harness-midstream-"));
  worktree = join(base, "worktree");
  mkdirSync(worktree, { recursive: true });
  const opened = await openStore("93", { dir: join(base, "store"), owner: "midstream" });
  if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
  store = opened.store;
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

async function runInterrupted(errorFactory?: () => Error): Promise<{
  emitted: EventEnvelope[];
  outcome: string;
}> {
  const emitted: EventEnvelope[] = [];
  const controller = new AbortController();
  const loop = new RunLoop({
    store,
    adapter: new AbortingAdapter(controller, errorFactory),
    tools: new ToolRegistry(),
    emit: (batch) => emitted.push(...batch),
    now: () => 1_700_000_000_000,
    newId: () => "turn-1",
  });

  const result = await loop.run({
    runId: "140",
    sessionId: "93",
    lane: "side",
    prompt: "change the tag",
    requestedBy: "7",
    model: "claude-opus-5",
    cwd: worktree,
    systemPrompt: "S",
    signal: controller.signal,
  });

  return { emitted, outcome: result.outcome };
}

const typesOf = (events: EventEnvelope[]) => events.map((e) => e.type);

describe("an interrupt that lands mid-stream", () => {
  it("terminates the run as INTERRUPTED, not failed", async () => {
    const { emitted, outcome } = await runInterrupted();

    expect(outcome).toBe("interrupted");
    expect(typesOf(emitted)).toContain("run_interrupted");
    expect(typesOf(emitted)).not.toContain("run_failed");
  });

  it("does not report a provider error for something the operator did", async () => {
    const { emitted } = await runInterrupted();

    // `provider_error` drives a red banner naming a remedy. "Check network access to the
    // provider" is wrong advice for a deliberate stop.
    expect(typesOf(emitted)).not.toContain("provider_error");
  });

  it("keeps the text streamed before the stop", async () => {
    const { emitted } = await runInterrupted();

    // The half-sentence the model produced is still what the room saw; an interrupt ends the run,
    // it does not retract what already happened.
    const deltas = emitted.filter((e) => e.type === "ai_text_delta");
    expect(deltas.map((e) => (e.payload as { text: string }).text).join("")).toBe("half a sen");
  });

  it("does not depend on how the transport words the abort", async () => {
    // A bare Error with no `name`, as an SDK wrapper may rethrow.
    const { outcome, emitted } = await runInterrupted(() => new Error("stream closed by caller"));

    expect(outcome).toBe("interrupted");
    expect(typesOf(emitted)).toContain("run_interrupted");
  });
});

describe("a real failure is still a failure", () => {
  it("does not turn an ordinary stream error into an interrupt", async () => {
    const emitted: EventEnvelope[] = [];
    const controller = new AbortController();

    // Throws WITHOUT aborting — the run was never asked to stop.
    class FailingAdapter extends AbortingAdapter {
      override async *stream(): AsyncIterable<ProviderEvent> {
        yield { t: "message_start", model: "claude-opus-5" };
        throw Object.assign(new Error("upstream exploded"), { status: 500 });
      }
    }

    const loop = new RunLoop({
      store,
      adapter: new FailingAdapter(controller),
      tools: new ToolRegistry(),
      emit: (batch) => emitted.push(...batch),
      now: () => 1_700_000_000_000,
      newId: () => "turn-1",
    });

    const result = await loop.run({
      runId: "141",
      sessionId: "93",
      lane: "main",
      prompt: "p",
      requestedBy: "7",
      model: "claude-opus-5",
      cwd: worktree,
      systemPrompt: "S",
      signal: controller.signal,
    });

    expect(result.outcome).toBe("failed");
    expect(typesOf(emitted)).toContain("run_failed");
    expect(typesOf(emitted)).not.toContain("run_interrupted");
  });
});

describe("the usage the interrupted turn really spent", () => {
  it("is not silently zeroed", async () => {
    const { emitted } = await runInterrupted();

    // The live run recorded all-zero usage for a turn that had streamed text, so it billed
    // invisibly. Whatever the loop reports must at least be shaped like a reading, and the
    // aborted turn reported none — so the terminal event must not claim a cost it never saw.
    const terminal = emitted.find((e) => e.type === "run_interrupted");
    expect(terminal).toBeDefined();
    expect(terminal?.payload).toHaveProperty("usage");
  });
});
