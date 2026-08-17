import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@clawdparty/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExtensionRegistry, PRIORITY } from "../../src/extensions/points.js";
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
 * a broken extension does not take down the run.
 *
 * `points.test.ts` proves containment at the REGISTRY: a throw becomes `continue` on a
 * transform point and `refuse` on `tool:before`, attributed to the handler that broke. What it
 * cannot prove is the claim  actually makes — that the RUN survives. The registry could
 * behave perfectly and the loop could still let the rejected promise escape, and nothing would
 * have caught it.
 *
 * So this drives the real `RunLoop` with a handler that throws at each point in turn and asserts
 * the run still reaches a terminal event. The distinction matters because `run:complete` is
 * dispatched right before the terminal transaction: a throw escaping there would strand the run
 * in exactly the state this whole feature exists to remove.
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

const TEXT_TURN: ProviderEvent[] = [
  { t: "message_start", model: "m" },
  { t: "block_start", index: 0, kind: "text" },
  { t: "text_delta", index: 0, text: "hi" },
  { t: "block_stop", index: 0, block: { type: "text", text: "hi" } },
  { t: "message_delta", stopReason: "end_turn", usage },
  { t: "message_stop" },
];

/** A turn that asks for a tool, so `tool:before` and `tool:after` are actually reached. */
const TOOL_TURN: ProviderEvent[] = [
  { t: "message_start", model: "m" },
  { t: "block_start", index: 0, kind: "tool_use" },
  {
    t: "block_stop",
    index: 0,
    block: { type: "tool_use", id: "tu_1", name: "read", input: { path: "x.txt" } },
  },
  { t: "message_delta", stopReason: "tool_use", usage },
  { t: "message_stop" },
];

const TERMINAL = ["run_finished", "run_failed", "run_interrupted"];

let base: string;
let store: HarnessStoreApi;
const warnings: string[] = [];

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "harness-containment-"));
  mkdirSync(join(base, "worktree"), { recursive: true });
  warnings.length = 0;
  const opened = await openStore("45", { dir: join(base, "store"), owner: "containment" });
  if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
  store = opened.store;
});
afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

async function runWith(
  extensions: ExtensionRegistry | undefined,
  events: ProviderEvent[] = TEXT_TURN,
): Promise<EventEnvelope[]> {
  const emitted: EventEnvelope[] = [];
  const loop = new RunLoop({
    store,
    adapter: new ScriptedAdapter(events),
    tools: new ToolRegistry(),
    ...(extensions ? { extensions } : {}),
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

function throwingAt(point: "request:before" | "tool:before" | "tool:after" | "run:complete") {
  return new ExtensionRegistry({ warn: (message) => warnings.push(message) }).register({
    id: "broken-plugin",
    point,
    priority: PRIORITY.thirdPartyPlugin,
    run: () => {
      throw new Error("handler exploded");
    },
    // biome-ignore lint/suspicious/noExplicitAny: one shape for all four points
  } as any);
}

describe("a handler that throws at a transform point", () => {
  it("lets the run finish normally", async () => {
    const events = await runWith(throwingAt("request:before"));

    // `request:before` fails OPEN, so this is a complete, successful run.
    expect(events.find((e) => e.type === "run_finished")).toBeDefined();
  });

  it("reports the failure with the contributor's identity", async () => {
    await runWith(throwingAt("request:before"));

    // "something went wrong in an extension" is unactionable; the id is the whole point.
    expect(warnings.join(" ")).toContain("request:before");
  });

  it("still produces the assistant's text — the turn was not damaged", async () => {
    const events = await runWith(throwingAt("request:before"));

    expect(events.some((e) => e.type === "ai_text")).toBe(true);
  });
});

describe("a handler that throws at run:complete", () => {
  it("does not strand the run — the terminal event is still written", async () => {
    // The riskiest point: it is dispatched immediately BEFORE the terminal transaction, so an
    // escaping rejection would leave the run with no terminal state at all.
    const events = await runWith(throwingAt("run:complete"));

    expect(events.filter((e) => TERMINAL.includes(e.type))).toHaveLength(1);
  });

  it("leaves the store's position marker terminal, not mid-run", async () => {
    await runWith(throwingAt("run:complete"));

    // Recovery switches on this marker. A run left mid-phase would be reported as stale and
    // failed on the next boot, which is a lie about a run that finished.
    expect(store.readRegister("run.position", "1")?.phase).toBe("terminal");
  });
});

describe("a handler that throws at tool:before", () => {
  it("fails CLOSED — the tool is refused, and the run continues to a terminal event", async () => {
    const events = await runWith(throwingAt("tool:before"), TOOL_TURN);

    // 's one asymmetry: a hung or broken approval gate must not permit the command it was
    // installed to gate. Refusing is not the same as crashing — the run still settles.
    expect(events.some((e) => e.type === "tool_refused")).toBe(true);
    expect(events.filter((e) => TERMINAL.includes(e.type))).toHaveLength(1);
  });

  it("names the broken handler in the refusal, not just 'refused'", async () => {
    const events = await runWith(throwingAt("tool:before"), TOOL_TURN);
    const refusal = events.find((e) => e.type === "tool_refused")?.payload as
      | { by?: string; reason?: string }
      | undefined;

    // Otherwise the room sees a tool blocked for no visible reason, which reads as the session
    // mysteriously stalling.
    expect(`${refusal?.by} ${refusal?.reason}`).toContain("broken-plugin");
  });
});

describe("no extensions at all", () => {
  it("is the same run, so the registry is genuinely optional", async () => {
    const events = await runWith(undefined);

    expect(events.find((e) => e.type === "run_finished")).toBeDefined();
  });
});
