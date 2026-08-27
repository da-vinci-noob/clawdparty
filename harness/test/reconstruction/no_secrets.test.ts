import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { BashTool } from "../../src/tools/bash.js";
import { ToolRegistry } from "../../src/tools/registry.js";

/**
 * / invariant 10 — no value of a credential the HARNESS HOLDS reaches the record.
 *
 * The harness authenticates with whatever the host developer already has, inherited through
 * the environment. Those values are live and they are the developer's, not the
 * app's, so the promise is specifically that they never land in a store, a projection, or a
 * participant's feed. A session's record outlives the run and is copied around; a key in it
 * is a key leaked to everyone who was ever in the room, including a `viewer` invited by link.
 *
 * SCOPE, stated because the boundary is easy to over-claim: this covers the harness's OWN
 * auth material. It does NOT promise that a secret living in the target repository stays out
 * of the record — Claude reads files and runs commands, and a participant watching the feed
 * is the point of the product. That is a different guarantee with a different mechanism
 * (`RepoBrowser`'s denylist), and conflating them would let this test look like protection it
 * does not provide.
 *
 * Every planted value contains `CANARY` and none is a real credential, so the assertion is a
 * substring search over the whole record rather than a set of shape patterns that a novel
 * secret format would slip past.
 */

const MARK = "CANARY";
const CREDS = {
  ANTHROPIC_API_KEY: `sk-ant-api03-${MARK}-not-a-real-key`,
  ANTHROPIC_AUTH_TOKEN: `${MARK}-bearer-not-a-real-token`,
  CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-${MARK}-not-a-real-oauth`,
};

const CAPS: Capabilities = {
  streaming: true,
  toolUse: true,
  toolUseWhileStreaming: true,
  contextWindow: 1_000_000,
  maxOutputTokens: 64_000,
  adaptiveThinking: true,
  thinkingBudgetTokens: null,
  thinkingDisplaySummarized: true,
  effortLevels: ["low", "medium", "high", "xhigh", "max"],
  promptCaching: true,
  minCacheablePrefixTokens: 512,
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

function turn(blocks: ProviderEvent[][], stopReason: "tool_use" | "end_turn"): ProviderEvent[] {
  return [
    { t: "message_start", model: "claude-opus-5" },
    ...blocks.flat(),
    {
      t: "message_delta",
      stopReason,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    { t: "message_stop" },
  ];
}

function bashCall(index: number, id: string, command: string): ProviderEvent[] {
  return [
    { t: "block_start", index, kind: "tool_use" },
    { t: "block_stop", index, block: { type: "tool_use", id, name: "bash", input: { command } } },
  ];
}

let base: string;
let worktree: string;
let store: HarnessStoreApi;
let emitted: EventEnvelope[];
let saved: Record<string, string | undefined>;

function dbPath(): string {
  return join(base, "store", "session-45.sqlite3");
}

/** Every place a value could hide: payloads, verbatim blocks, registers, the raw file. */
function recordText(): string {
  const entries = store.entriesFrom(0);
  const registers = ["run.meta", "run.position", "run.tool_args", "run.result", "session.fact"]
    .flatMap((ns) => ["1", "45", "main", "1:1:0", "1:2:0"].map((key) => [ns, key] as const))
    .map(([ns, key]) => JSON.stringify(store.readRegister(ns as "run.meta", key) ?? null))
    .join("\n");

  return [
    JSON.stringify(entries.map((e) => e.payload)),
    JSON.stringify(entries.map((e) => e.blocks)),
    registers,
    JSON.stringify(emitted),
  ].join("\n");
}

async function run(turns: ProviderEvent[][], prompt = "do the thing") {
  const loop = new RunLoop({
    store,
    adapter: new ScriptedAdapter(turns),
    tools: new ToolRegistry().register(new BashTool().definition),
    emit: (events) => emitted.push(...events),
    now: () => 1_700_000_000_000,
    newId: () => "turn-1",
  });
  return loop.run({
    runId: "1",
    sessionId: "45",
    lane: "main",
    prompt,
    requestedBy: "7",
    model: "claude-opus-5",
    cwd: worktree,
    systemPrompt: "You are clawdparty.",
    signal: new AbortController().signal,
  });
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "harness-secrets-"));
  worktree = join(base, "worktree");
  mkdirSync(worktree, { recursive: true });

  saved = {};
  for (const [key, value] of Object.entries(CREDS)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }

  const opened = await openStore("45", { dir: join(base, "store"), owner: "secrets" });
  if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
  store = opened.store;
  emitted = [];
});

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await store.close();
  rmSync(base, { recursive: true, force: true });
});

describe("a tool subprocess cannot see the harness's credentials", () => {
  it("does not hand them to a command that asks for them by name", async () => {
    await run([
      turn(
        [bashCall(0, "toolu_1", "printenv ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN")],
        "tool_use",
      ),
      turn([], "end_turn"),
    ]);

    // The env is what makes this reachable at all. `toolchainEnv` spread the whole of
    // process.env into the child, so ONE `printenv` put the developer's live key into a
    // durable entry and onto every participant's screen — including a viewer invited by
    // link. Removing them from the child beats redacting on the way in: a pattern list
    // never covers `base64` of the same value, and an absent variable cannot be encoded.
    expect(recordText()).not.toContain(MARK);
  });

  it("leaves the parent process's own environment untouched", () => {
    // The harness still needs the credential to authenticate — the child is what must not
    // have it. Stripping it globally would break the next request instead.
    expect(process.env.ANTHROPIC_API_KEY).toContain(MARK);
  });

  it("does not leak them through a whole `env` dump either", async () => {
    await run([turn([bashCall(0, "toolu_1", "env")], "tool_use"), turn([], "end_turn")]);

    // Naming the variables in the command is the easy case. A blanket dump is what a
    // debugging session actually runs.
    expect(recordText()).not.toContain(MARK);
  });
});

describe("the record names the credential SOURCE and never the value", () => {
  it("keeps the source in request_header so the run is still auditable", async () => {
    await run([turn([], "end_turn")]);

    const header = emitted.find((e) => e.type === "request_header");
    const payload = JSON.stringify(header?.payload ?? {});

    // Withholding the value must not degrade into withholding everything: which credential
    // a run authenticated with is exactly what an audit needs.
    expect(payload).toContain("credential_source");
    expect(payload).not.toContain(MARK);
  });

  it("keeps them out of the raw database file, not just the read API", async () => {
    await run([turn([bashCall(0, "toolu_1", "env")], "tool_use"), turn([], "end_turn")]);

    // A value reaching an unexpected column would still be on disk. Under WAL the newest
    // pages are in the -wal file, so scanning only the main DB would miss what was just
    // written; latin1 keeps the bytes searchable where utf8 would mangle them.
    const bytes = readFileSync(dbPath(), "latin1") + readFileSync(`${dbPath()}-wal`, "latin1");
    expect(bytes).not.toContain(MARK);
  });
});

describe("the scan itself is not vacuous", () => {
  it("WOULD catch a value that reached the record", async () => {
    await run([
      turn([bashCall(0, "toolu_1", `echo ${MARK}-planted`)], "tool_use"),
      turn([], "end_turn"),
    ]);

    // Same mechanism, a value the harness never claimed to hide: this is repository
    // content, and the feed showing it is the product working. Asserted so a future
    // refactor that silently stops recording terminal output cannot make every test above
    // pass by writing nothing at all.
    expect(recordText()).toContain(`${MARK}-planted`);
  });
});
