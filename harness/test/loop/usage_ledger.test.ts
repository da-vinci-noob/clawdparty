import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
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
import type { HarnessStoreApi, UsageRow } from "../../src/store/types.js";
import { ToolRegistry } from "../../src/tools/registry.js";

/**
 * consumption is an APPEND-ONLY ledger, populated from the provider's own
 * `message_delta` usage.
 *
 * Append-only rather than a running total on the run, because a total answers "what did this
 * cost" and nothing else. A ledger answers which turn cost what, which is the question asked
 * when a run is surprisingly expensive — and a total that is recomputed cannot be audited
 * against the turns that produced it.
 *
 * Read through raw SQL rather than a store method: there is deliberately no API to read the
 * ledger back, so nothing in the loop can be tempted to make a decision from it.
 */

const CAPS: Capabilities = {
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
  private at = 0;

  constructor(private readonly turns: ProviderEvent[][]) {}

  async probe(): Promise<ProbeResult> {
    return { available: true, credentialSource: "env:ANTHROPIC_API_KEY" };
  }
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "claude-opus-5", displayName: "Opus", capabilities: CAPS }];
  }
  capabilities(): Capabilities {
    return CAPS;
  }
  async *stream(): AsyncIterable<ProviderEvent> {
    for (const event of this.turns[this.at++] ?? []) yield event;
  }
}

/** One turn, with the usage figures the provider reported for it. */
function turn(
  body: string,
  usage: [number, number, number, number],
  stopReason: "end_turn" | "tool_use" = "end_turn",
): ProviderEvent[] {
  const [input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens] = usage;
  return [
    { t: "message_start", model: "claude-opus-5" },
    ...(stopReason === "tool_use"
      ? ([
          { t: "block_start", index: 0, kind: "tool_use" },
          {
            t: "block_stop",
            index: 0,
            block: { type: "tool_use", id: "toolu_1", name: "read", input: { path: "x.txt" } },
          },
        ] as ProviderEvent[])
      : ([
          { t: "block_start", index: 0, kind: "text" },
          { t: "block_stop", index: 0, block: { type: "text", text: body } },
        ] as ProviderEvent[])),
    {
      t: "message_delta",
      stopReason,
      usage: {
        input_tokens,
        output_tokens,
        cache_read_input_tokens,
        cache_creation_input_tokens,
      },
    },
    { t: "message_stop" },
  ];
}

let base: string;
let dir: string;
let worktree: string;
let store: HarnessStoreApi;

function dbPath(): string {
  return join(dir, "session-45.sqlite3");
}

function ledger(): UsageRow[] {
  const raw = new Database(dbPath(), { readonly: true });
  const rows = raw.prepare("SELECT * FROM usage ORDER BY id").all() as UsageRow[];
  raw.close();
  return rows;
}

async function run(turns: ProviderEvent[][]) {
  const loop = new RunLoop({
    store,
    adapter: new ScriptedAdapter(turns),
    tools: new ToolRegistry(),
    emit: () => {},
    now: () => 1_700_000_000_000,
    newId: () => "turn-1",
  });
  return loop.run({
    runId: "1",
    sessionId: "45",
    lane: "main",
    prompt: "P",
    requestedBy: "7",
    model: "claude-opus-5",
    cwd: worktree,
    systemPrompt: "S",
    signal: new AbortController().signal,
  });
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "harness-usage-"));
  dir = join(base, "store");
  worktree = join(base, "worktree");
  mkdirSync(worktree, { recursive: true });
  const opened = await openStore("45", { dir, owner: "usage" });
  if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
  store = opened.store;
});

afterEach(async () => {
  await store.close();
  rmSync(base, { recursive: true, force: true });
});

describe("the ledger records what the provider reported", () => {
  it("writes the provider's own figures, not a recomputation", async () => {
    await run([turn("hi", [111, 22, 5, 3])]);
    await store.close();

    // Cache reads and cache CREATION are billed differently from ordinary input, so
    // collapsing them into one number makes a cost figure that cannot be reconciled with
    // an invoice.
    expect(ledger()).toHaveLength(1);
    expect(ledger()[0]).toMatchObject({
      run_id: "1",
      provider: "scripted",
      model: "claude-opus-5",
      input_tokens: 111,
      output_tokens: 22,
      cache_read: 5,
      cache_creation: 3,
    });
  });

  it("writes ONE row per REQUEST, so a run's cost decomposes", async () => {
    // The first turn must be non-terminal or the run settles after one request — `end_turn`
    // means done, so a two-element script would only ever stream its first element.
    await run([turn("one", [100, 10, 0, 0], "tool_use"), turn("two", [200, 20, 0, 0])]);
    await store.close();

    // The whole reason it is a ledger. A single total cannot answer "which turn was
    // expensive", which is the question a surprising bill actually raises.
    expect(ledger().map((r) => r.input_tokens)).toEqual([100, 200]);
  });

  it("refuses to rewrite a row, at the DATABASE level", async () => {
    await run([turn("hi", [100, 10, 0, 0])]);
    await store.close();
    const raw = new Database(dbPath());

    // Append-only by trigger, not by convention: a corrected figure has to be a new row,
    // so the history of what was believed stays readable.
    expect(() => raw.prepare("UPDATE usage SET input_tokens = 0").run()).toThrow(/append-only/);
    raw.close();
  });

  it("records nothing when a turn reported nothing", async () => {
    await run([
      [
        { t: "message_start", model: "claude-opus-5" },
        { t: "block_start", index: 0, kind: "text" },
        { t: "block_stop", index: 0, block: { type: "text", text: "hi" } },
        { t: "message_stop" },
      ],
    ]);
    await store.close();

    // No `message_delta`, so no figures. A zero row would assert the turn was free, which
    // is a claim the harness cannot support — the difference between "free" and "unknown".
    // An adapter that forgets to report should leave a visible hole, not a free-looking run.
    expect(ledger()).toHaveLength(0);
  });

  it("leaves entry_store_seq unset for now", async () => {
    await run([turn("hi", [100, 10, 0, 0])]);
    await store.close();

    // Asserted as-is rather than assumed. The column exists to link a usage row to its
    // position in the log, which is also the marker a mid-run request reconstruction needs
    // — a follow-up populates it, and this test deliberately does not guess at the value here.
    expect(ledger()[0]?.entry_store_seq).toBeNull();
  });
});
