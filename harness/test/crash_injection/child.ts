import type { EventEnvelope } from "@clawdparty/contracts";
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
import type { HarnessStoreApi, Transaction } from "../../src/store/types.js";
import { type ToolDefinition, ToolRegistry } from "../../src/tools/registry.js";
import { recordEffect } from "./harness.js";

/**
 * The process that gets killed.
 *
 * Runs the representative narrative — parallel tool calls, one of them a `never`-policy
 * `bash`, then a follow-up turn — against a real store, and SIGKILLs ITSELF at commit
 * number `CRASH_KILL_AT`.
 *
 * Self-kill rather than the parent signalling: the parent cannot know when a specific
 * commit lands without racing it, and a race would sample a different state on every
 * run. Killing from inside the commit boundary makes the crash point exact and the whole
 * suite deterministic.
 */

const dir = process.env.CRASH_DIR ?? "";
const effects = process.env.CRASH_EFFECTS ?? "";
const killAt = process.env.CRASH_KILL_AT === "" ? null : Number(process.env.CRASH_KILL_AT);
const SESSION = "session_crash";
const RUN = "run_crash";

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
    note: "crash-injection",
  };
  private at = 0;

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
    const turn = this.at++;
    if (turn === 0) {
      // Text, then TWO parallel tool calls with DIFFERENT replay policies — the case
      // that proves recovery decides per call rather than per turn.
      yield { t: "block_start", index: 0, kind: "text" };
      yield { t: "text_delta", index: 0, text: "Working on it." };
      yield { t: "block_stop", index: 0, block: { type: "text", text: "Working on it." } };
      yield {
        t: "block_stop",
        index: 1,
        block: { type: "tool_use", id: "tu_bash", name: "bash", input: { command: "echo one" } },
      };
      yield {
        t: "block_stop",
        index: 2,
        block: { type: "tool_use", id: "tu_read", name: "read", input: { path: "a.txt" } },
      };
      yield { t: "message_delta", stopReason: "tool_use", usage: usage() };
      yield { t: "message_stop" };
      return;
    }
    // The follow-up turn: a plain answer that ends the run.
    yield { t: "block_start", index: 0, kind: "text" };
    yield { t: "text_delta", index: 0, text: "Done." };
    yield { t: "block_stop", index: 0, block: { type: "text", text: "Done." } };
    yield { t: "message_delta", stopReason: "end_turn", usage: usage() };
    yield { t: "message_stop" };
  }
}

function usage() {
  return {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

/**
 * `bash` is `replay: "never"` and records an IRREVERSIBLE effect to the filesystem.
 * That file is the whole  assertion: if recovery re-runs this call, the file has
 * two lines, and no in-memory bookkeeping could have told us.
 */
function tools(): ToolRegistry {
  const bash: ToolDefinition = {
    name: "bash",
    replay: "never",
    schema: { type: "bash_20250124", name: "bash" },
    run: async () => {
      recordEffect(effects, "bash:echo one");
      return { content: [{ type: "text", text: "one" }], isError: false };
    },
  };
  const read: ToolDefinition = {
    name: "read",
    replay: "safe",
    schema: { name: "read", description: "read a file", input_schema: { type: "object" } },
    run: async () => ({ content: [{ type: "text", text: "file body" }], isError: false }),
  };
  // The REAL registry, not a hand-rolled stand-in. A cast-to-interface stub passed the
  // typecheck and then died on `schemasFor` at runtime — the loop uses more of this
  // surface than a stub author remembers, and every addition would break it again.
  return new ToolRegistry().register(bash).register(read);
}

/**
 * Wrap the ONLY write primitive so every commit is a numbered crash point, then kill
 * AFTER the target commit has been applied. Killing before it would test a state the
 * store never reached.
 */
function countingStore(store: HarnessStoreApi): HarnessStoreApi {
  let commits = 0;
  const original = store.commit.bind(store);
  return Object.assign(Object.create(Object.getPrototypeOf(store)), store, {
    commit(tx: Transaction) {
      const result = original(tx);
      commits += 1;
      process.stdout.write(`COMMITS=${commits}\n`);
      if (killAt !== null && commits >= killAt) {
        // SIGKILL, not exit(): unmaskable, no flush, no finally. A real crash gives the
        // loop no chance to tidy up and neither does this.
        process.kill(process.pid, "SIGKILL");
      }
      return result;
    },
  }) as HarnessStoreApi;
}

async function main(): Promise<void> {
  const opened = await openStore(SESSION, { dir, staleAfterMs: 0 });
  if (!opened.ok) throw new Error(`child could not open the store: ${opened.reason}`);
  const store = countingStore(opened.store);

  const loop = new RunLoop({
    store,
    adapter: new ScriptedAdapter(),
    tools: tools(),
    emit: (_events: EventEnvelope[]) => {},
    now: () => 1_700_000_000_000,
    newId: () => "id_fixed",
  });

  await loop.run({
    runId: RUN,
    sessionId: SESSION,
    lane: "main",
    prompt: "do the thing",
    requestedBy: "1",
    model: "claude-opus-5",
    cwd: dir,
    systemPrompt: "be brief",
    signal: new AbortController().signal,
  });

  await opened.store.close();
}

main().catch((err) => {
  process.stderr.write(`child failed: ${String(err)}\n`);
  process.exit(2);
});
