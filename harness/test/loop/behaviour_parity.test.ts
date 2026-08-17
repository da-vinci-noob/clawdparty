import { readFileSync } from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EPHEMERAL_EVENT_TYPES,
  type EventEnvelope,
  SYNTHESIZED_EVENT_TYPES,
} from "@clawdparty/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TURNS } from "../../scripts/narrative.js";
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
import * as read from "../../src/tools/read.js";
import { ToolRegistry, textResult } from "../../src/tools/registry.js";
import * as textEditor from "../../src/tools/text_editor.js";

/**
 * M0's success criterion is that NOTHING CHANGED: same five never-cut flows, same
 * events, same UI, different engine. This test is what makes that claim checkable
 * rather than asserted.
 *
 * It drives the new loop with a scripted adapter that reproduces the narrative
 * captured in `sample_run.jsonl` — thinking, text, a failing tool, a succeeding
 * tool, a bash tool, a closing answer — and compares the emitted envelope sequence
 * against the fixture's.
 *
 * WHAT IS COMPARED, and why the comparison is filtered: the v1.5 types
 * (`request_header`, `context_usage`, …) are ADDITIVE contract changes declared in
 * the migration window, so the loop is expected to emit them and the fixture's
 * pre-v1.5 run does not. The comparison therefore filters to the 22 original
 * names. Filtering the OTHER way — ignoring order, or comparing sets instead of
 * sequences — would make this vacuous, so order is asserted exactly.
 */

const FIXTURE = fileURLToPath(
  new URL("../../../packages/contracts/fixtures/sample_run.jsonl", import.meta.url),
);

const EPHEMERAL = new Set<string>(EPHEMERAL_EVENT_TYPES);
const SYNTHESIZED = new Set<string>(SYNTHESIZED_EVENT_TYPES);

/** Types added at v1.5, which the fixture's original run predates. */
const V15_ONLY = new Set<string>([
  "request_header",
  "context_compacted",
  "context_usage",
  "tool_refused",
  "plugin_enabled",
  "plugin_disabled",
  "provider_error",
  "recovery_applied",
]);

function fixtureEvents(): EventEnvelope[] {
  return readFileSync(FIXTURE, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as EventEnvelope);
}

/**
 * The fixture's durable, run-scoped, pre-v1.5 type sequence — the shape a
 * participant saw before the harness owned the loop. `user_prompt` is excluded
 * because the fixture places its follow-up mid-run, which is a different narrative
 * from the single-prompt run scripted here.
 */
function fixtureBaseline(): string[] {
  return fixtureEvents()
    .filter((e) => e.ai_run_id !== null && e.id !== null)
    .map((e) => e.type)
    .filter((t) => !V15_ONLY.has(t) && t !== "user_prompt");
}

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

type Turn = ProviderEvent[];

/** A scripted adapter: each `stream()` call plays the next turn in order. */
class ScriptedAdapter implements ProviderAdapter {
  readonly id = "scripted";
  readonly displayName = "Scripted";
  readonly entitlement: EntitlementPosture = {
    credentialKind: "api_key",
    thirdPartyClientPermitted: "yes",
    note: "test",
  };
  readonly requests: unknown[] = [];
  private at = 0;

  constructor(private readonly turns: Turn[]) {}

  async probe(): Promise<ProbeResult> {
    return { available: true, credentialSource: "env:ANTHROPIC_API_KEY" };
  }
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "claude-opus-5", displayName: "Claude Opus 5", capabilities: CAPS }];
  }
  capabilities(): Capabilities {
    return CAPS;
  }
  async *stream(req: unknown): AsyncIterable<ProviderEvent> {
    this.requests.push(req);
    const turn = this.turns[this.at++] ?? [];
    for (const event of turn) yield event;
  }
}

function block(index: number, kind: "text" | "thinking", text: string): ProviderEvent[] {
  return [
    { t: "block_start", index, kind },
    kind === "text" ? { t: "text_delta", index, text } : { t: "thinking_delta", index, text },
    {
      t: "block_stop",
      index,
      block:
        kind === "text"
          ? { type: "text", text }
          : { type: "thinking", thinking: text, signature: "sig" },
    },
  ];
}

function toolUse(index: number, id: string, name: string, input: unknown): ProviderEvent[] {
  return [
    { t: "block_start", index, kind: "tool_use" },
    { t: "tool_input_delta", index, partialJson: JSON.stringify(input) },
    { t: "block_stop", index, block: { type: "tool_use", id, name, input } },
  ];
}

function turn(blocks: ProviderEvent[][], stopReason: "tool_use" | "end_turn"): Turn {
  return [
    { t: "message_start", model: "claude-opus-5" },
    ...blocks.flat(),
    {
      t: "message_delta",
      stopReason,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
    },
    { t: "message_stop" },
  ];
}

let base: string;
let dir: string;
let worktree: string;
let store: HarnessStoreApi;
let emitted: EventEnvelope[];

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "harness-parity-"));
  // The store dir and the worktree are separate, as they are in production: the
  // store lives outside any project tree.
  dir = join(base, "store");
  worktree = join(base, "worktree");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, "SPIKE_NOTE.md"), "hello from the spike\n");

  const opened = await openStore("45", { dir, owner: "parity" });
  if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
  store = opened.store;
  emitted = [];
});

afterEach(async () => {
  await store.close();
  rmSync(base, { recursive: true, force: true });
});

function registry(): ToolRegistry {
  const reg = new ToolRegistry()
    .register(new BashTool().definition)
    .register(textEditor.definition)
    .register(read.definition);
  // A file-writing tool that always fails, reproducing the fixture's
  // file_changed-then-tool_failed step without depending on a real filesystem
  // error. Named with a `create` command so the normalizer derives file_changed
  // from the call, exactly as it does for the real text editor.
  reg.register({
    name: "failing_writer",
    replay: "never",
    schema: { name: "failing_writer" },
    run: async () => textResult("could not do that", true),
  });
  reg.register({
    name: "always_fails",
    replay: "safe",
    schema: { name: "always_fails" },
    run: async () => textResult("could not do that", true),
  });
  return reg;
}

async function runScripted(turns: Turn[], cwd: string) {
  const adapter = new ScriptedAdapter(turns);
  let clock = 0;
  let turnNumber = 0;
  const loop = new RunLoop({
    store,
    adapter,
    tools: registry(),
    emit: (events) => emitted.push(...events),
    // Separate counters: sharing one made the turn id depend on how many times
    // the clock was read, which is exactly the kind of coupling a test should not
    // encode.
    now: () => 1_700_000_000_000 + clock++,
    newId: () => `turn-${++turnNumber}`,
  });

  const outcome = await loop.run({
    runId: "1",
    sessionId: "45",
    lane: "main",
    prompt: "add a note then summarize",
    requestedBy: "7",
    model: "claude-opus-5",
    cwd,
    systemPrompt: "You are clawdparty.",
    signal: new AbortController().signal,
  });
  return { outcome, adapter };
}

describe("behaviour parity — the executable contract still holds", () => {
  it("reproduces the fixture's durable type sequence for the SHARED narrative", async () => {
    // Replays the SAME narrative `scripts/capture_fixture.ts` generated the fixture from —
    // imported, not restated. When the two were separate scripts this comparison silently
    // came out empty and passed as "nothing to compare".
    //
    // A generated fixture cannot prove the harness CORRECT; it is checking the harness
    // against its own output. It proves the harness STABLE: an unintended change to the
    // durable type sequence fails here and has to be regenerated on purpose. The
    // correctness properties are asserted separately below, where the fixture is not the
    // authority.
    const { outcome } = await runScripted(TURNS, worktree);

    expect(outcome.outcome).toBe("finished");

    const produced = emitted
      .filter((e) => e.seq !== null)
      .map((e) => e.type)
      .filter((t) => !V15_ONLY.has(t) && t !== "user_prompt");

    expect(produced).toEqual(fixtureBaseline());
  });

  it("assigns durable seq gaplessly from 1 and never to an ephemeral event", async () => {
    await runScripted([turn([block(0, "text", "hi")], "end_turn")], worktree);

    const durable = emitted.filter((e) => e.seq !== null);
    expect(durable.map((e) => e.seq)).toEqual(durable.map((_unused, i) => i + 1));

    for (const event of emitted) {
      if (EPHEMERAL.has(event.type)) {
        expect(event.seq, `${event.type} must not consume a seq`).toBeNull();
        expect(event.id, `${event.type} must carry a null id`).toBeNull();
      }
    }
  });

  it("streams a delta and settles it under the SAME block key", async () => {
    await runScripted([turn([block(0, "text", "streamed answer")], "end_turn")], worktree);

    const delta = emitted.find((e) => e.type === "ai_text_delta");
    const durable = emitted.find((e) => e.type === "ai_text");

    expect((delta?.payload as { block: string }).block).toBe(
      (durable?.payload as { block: string }).block,
    );
    // `<turnId>:<index>`, per the contract — NOT `<id>:<kind>`, which collides when
    // one turn emits two text blocks.
    expect((durable?.payload as { block: string }).block).toBe("turn-1:0");
  });

  it("gives two text blocks of one turn DISTINCT keys", async () => {
    // The concrete failure the index-based key prevents: under the old
    // `<id>:<kind>` scheme both blocks share a key and the reducer concatenates
    // unrelated text.
    await runScripted(
      [turn([block(0, "text", "first"), block(1, "text", "second")], "end_turn")],
      worktree,
    );

    const keys = emitted
      .filter((e) => e.type === "ai_text")
      .map((e) => (e.payload as { block: string }).block);

    expect(keys).toEqual(["turn-1:0", "turn-1:1"]);
    expect(new Set(keys).size).toBe(2);
  });

  it("records the surface with VERBATIM blocks, so the next request carries them", async () => {
    await runScripted([turn([block(0, "thinking", "reasoning")], "end_turn")], worktree);

    const surface = store.surfaceFrom(0);
    const thinking = surface
      .flatMap((e) => e.blocks ?? [])
      .find((b) => (b as { type?: string }).type === "thinking");

    // Flattening to text would lose the signature, and the provider rejects an
    // edited thinking block on the next turn.
    expect(thinking).toEqual({ type: "thinking", thinking: "reasoning", signature: "sig" });
  });

  it("returns every tool result in a SINGLE user message", async () => {
    const { adapter } = await runScripted(
      [
        turn(
          [toolUse(0, "toolu_1", "always_fails", {}), toolUse(1, "toolu_2", "always_fails", {})],
          "tool_use",
        ),
        turn([block(0, "text", "done")], "end_turn"),
      ],
      worktree,
    );

    // Asserted on the assembled REQUEST, not on how the results are stored. The property
    // that matters is what the provider receives — splitting results across messages
    // silently trains the model to stop making parallel calls — and the storage later moved to
    // one entry PER result so a crash between calls cannot lose them. Asserting the entry shape
    // would have pinned the storage detail and failed on a change that preserves the requirement.
    const followUp = adapter.requests.at(-1) as {
      messages: Array<{ role: string; content: Array<{ type?: string }> }>;
    };
    const withResults = followUp.messages.filter(
      (m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"),
    );

    expect(withResults).toHaveLength(1);
    expect(withResults[0]?.content.filter((b) => b.type === "tool_result")).toHaveLength(2);
  });

  it("stores each tool result as its OWN durable surface entry", async () => {
    await runScripted(
      [
        turn(
          [toolUse(0, "toolu_1", "always_fails", {}), toolUse(1, "toolu_2", "always_fails", {})],
          "tool_use",
        ),
        turn([block(0, "text", "done")], "end_turn"),
      ],
      worktree,
    );

    const resultEntries = store
      .surfaceFrom(0)
      .filter((e) => (e.blocks ?? []).some((b) => (b as { type?: string }).type === "tool_result"));

    // The durability half of the same requirement. Batched into one entry written after
    // every call finished, a crash in between lost the completed results for good:
    // recovery reads the position, sees `completed`, and neither re-runs nor synthesizes.
    expect(resultEntries).toHaveLength(2);
    for (const entry of resultEntries) {
      expect(entry.blocks).toHaveLength(1);
      // Settlement-keyed, so a result can only ever land once — the same identity
      // recovery would settle under.
      expect(entry.settlement_key).toBeTruthy();
    }
    expect(new Set(resultEntries.map((e) => e.settlement_key)).size).toBe(2);
  });

  it("leaves the run terminal with no run.* registers", async () => {
    await runScripted([turn([block(0, "text", "hi")], "end_turn")], worktree);

    expect(store.readPosition("1")).toEqual({ phase: "terminal", outcome: "finished" });
    expect(store.readRegister("run.meta", "1")).toBeNull();
    expect(store.readRegister("run.result", "1")).toMatchObject({ outcome: "finished" });
    expect(store.activeRunIds()).toEqual([]);
  });

  it("never sends a removed parameter, and always sets thinking.display", async () => {
    const { adapter } = await runScripted([turn([block(0, "text", "hi")], "end_turn")], worktree);

    const body = JSON.stringify(adapter.requests[0]);
    for (const removed of ["temperature", "top_p", "top_k", "budget_tokens"]) {
      expect(body).not.toContain(`"${removed}"`);
    }
    // Defaults to "omitted", which streams thinking with empty text — the feed
    // would show a long pause and then nothing.
    expect(body).toContain('"display":"summarized"');
  });

  it("emits request_header when ESTABLISHED OR CHANGED, not once per request", async () => {
    // The request-snapshot model: a reader folds the LATEST snapshot at or
    // before any point, so re-stating an unchanged one adds no information. Per
    // request, a 20-turn run would put 20 identical events in the feed.
    await runScripted(
      [
        turn([toolUse(0, "toolu_1", "always_fails", {})], "tool_use"),
        turn([toolUse(0, "toolu_2", "always_fails", {})], "tool_use"),
        turn([block(0, "text", "done")], "end_turn"),
      ],
      worktree,
    );

    const headers = emitted.filter((e) => e.type === "request_header");
    expect(headers, "three requests, one unchanged snapshot").toHaveLength(1);
  });

  it("BROADCASTS ephemeral events without persisting them", async () => {
    await runScripted([turn([block(0, "text", "hi")], "end_turn")], worktree);

    // events.ts: ephemeral events are "broadcast, never persisted". The loop mapped every
    // envelope from the turn into a store write, so the deltas went in too — carrying the
    // null seq that made them ephemeral in the first place. Nothing noticed because no test
    // looked at the store's entry TYPES, only at what was emitted.
    const stored = new Set(store.entriesFrom(0).map((e) => e.type));
    for (const type of EPHEMERAL_EVENT_TYPES) {
      expect(stored.has(type), `${type} was persisted`).toBe(false);
    }

    // The durable half of the same stream still lands, or this would pass by storing nothing.
    expect(stored.has("ai_text")).toBe(true);
    expect(emitted.some((e) => e.type === "ai_text_delta")).toBe(true);
  });

  it("emits the additive v1.5 types the fixture predates", async () => {
    await runScripted([turn([block(0, "text", "hi")], "end_turn")], worktree);
    const types = new Set(emitted.map((e) => e.type));

    // Asserted explicitly so the filtered comparison above cannot quietly hide
    // that these were never produced at all.
    expect(types.has("request_header")).toBe(true);
    expect(types.has("context_usage")).toBe(true);
    expect(SYNTHESIZED.has("request_header")).toBe(true);
  });
});
