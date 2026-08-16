import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@clawdparty/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LoopNormalizer } from "../../src/loop/normalize.js";
import { RunLoop } from "../../src/loop/run_loop.js";
import type {
  Capabilities,
  EntitlementPosture,
  ModelInfo,
  ProbeResult,
  ProviderAdapter,
  ProviderEvent,
} from "../../src/providers/contract.js";
import { AI_RAW_CAP_BYTES } from "../../src/redaction.js";
import { openStore } from "../../src/store/store.js";
import type { HarnessStoreApi } from "../../src/store/types.js";
import { ToolRegistry } from "../../src/tools/registry.js";

/**
 * a shape the harness does not recognise becomes `ai_raw`, and the run survives.
 *
 * This is the valve that keeps a provider's next release from taking the room down. The
 * normalizer maps a `ProviderEvent` the adapter defines, so it is total by construction —
 * but an adapter can still forward something it did not model, and a mapping can still
 * throw on a shape nobody anticipated. Either way the answer is the same: record it
 * verbatim-but-bounded and carry on.
 *
 * Tested end to end rather than at the normalizer, because the failure this prevents is a
 * DEAD RUN, and only the loop can demonstrate a run that lived.
 */

const CAPS: Capabilities = {
  streaming: true,
  toolUse: true,
  contextWindow: 1_000_000,
  maxOutputTokens: 64_000,
  adaptiveThinking: true,
  thinkingDisplaySummarized: true,
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

function turn(events: ProviderEvent[]): ProviderEvent[] {
  return [
    { t: "message_start", model: "claude-opus-5" },
    ...events,
    {
      t: "message_delta",
      stopReason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    { t: "message_stop" },
  ];
}

const text = (body: string): ProviderEvent[] => [
  { t: "block_start", index: 0, kind: "text" },
  { t: "block_stop", index: 0, block: { type: "text", text: body } },
];

let base: string;
let worktree: string;
let store: HarnessStoreApi;
let emitted: EventEnvelope[];

async function run(events: ProviderEvent[]) {
  const loop = new RunLoop({
    store,
    adapter: new ScriptedAdapter([turn(events)]),
    tools: new ToolRegistry(),
    emit: (batch) => emitted.push(...batch),
    now: () => 1_700_000_000_000,
    newId: () => "turn-1",
  });
  return loop.run({
    runId: "1",
    sessionId: "45",
    lane: "main",
    prompt: "go",
    requestedBy: "7",
    model: "claude-opus-5",
    cwd: worktree,
    systemPrompt: "You are clawdparty.",
    signal: new AbortController().signal,
  });
}

const rawEntries = () => store.entriesFrom(0).filter((e) => e.type === "ai_raw");

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "harness-airaw-"));
  worktree = join(base, "worktree");
  mkdirSync(worktree, { recursive: true });
  const opened = await openStore("45", { dir: join(base, "store"), owner: "airaw" });
  if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
  store = opened.store;
  emitted = [];
});

afterEach(async () => {
  await store.close();
  rmSync(base, { recursive: true, force: true });
});

describe("an unrecognized provider value survives as ai_raw", () => {
  it("finishes the run instead of failing it", async () => {
    const outcome = await run([
      { t: "raw", value: { some_future_thing: { nested: true } } } as ProviderEvent,
      ...text("still answered"),
    ]);

    // The whole point. A provider adding a field must not end the session.
    expect(outcome.outcome).toBe("finished");
  });

  it("persists the unknown value rather than dropping it", async () => {
    await run([
      { t: "raw", value: { some_future_thing: { nested: true } } } as ProviderEvent,
      ...text("hi"),
    ]);

    // Contract: never dropped. Backfill has to be able to hand it to a client that learns
    // to read it later, and a support question about a weird run has to be answerable.
    expect(rawEntries()).toHaveLength(1);
    expect(JSON.stringify(rawEntries()[0]?.payload)).toContain("some_future_thing");
  });

  it("carries a seq, so it takes its place in the ordered stream", async () => {
    await run([{ t: "raw", value: { x: 1 } } as ProviderEvent, ...text("hi")]);

    // `ai_raw` is DURABLE, not ephemeral. Emitting it without a seq would leave a client
    // unable to order it — the same defect the fixture recapture found in
    // `recovery_applied`.
    const entry = rawEntries()[0];
    expect(entry?.seq).not.toBeNull();
    expect(entry?.emitted).toBe(1);
    expect(emitted.some((e) => e.type === "ai_raw" && e.seq === entry?.seq)).toBe(true);
  });

  it("keeps it OFF the model surface", async () => {
    await run([{ t: "raw", value: { x: 1 } } as ProviderEvent, ...text("hi")]);

    // An unmapped value has no verbatim block the provider would accept back, so putting
    // it on the surface would make the NEXT request malformed.
    expect(rawEntries()[0]?.on_surface).toBe(0);
  });
});

describe("it is a valve, not a hole", () => {
  it("REDACTS a credential-shaped key before storing", async () => {
    await run([
      {
        t: "raw",
        value: { headers: { authorization: "Bearer CANARY-not-a-real-token" } },
      } as ProviderEvent,
      ...text("hi"),
    ]);

    // The valve records whatever it did not understand, which is exactly how a provider's
    // request echo would put a live token in the record. Redaction is by KEY NAME, so it
    // fires without having to recognise the value's shape.
    const stored = JSON.stringify(rawEntries()[0]?.payload);
    expect(stored).not.toContain("CANARY");
    expect(stored).toContain("REDACTED");
  });

  it("BOUNDS a huge value instead of storing all of it", async () => {
    await run([
      { t: "raw", value: { blob: "x".repeat(AI_RAW_CAP_BYTES * 3) } } as ProviderEvent,
      ...text("hi"),
    ]);

    const payload = rawEntries()[0]?.payload as { truncated?: boolean };
    // Unbounded, one runaway provider message would land in the record, the projection,
    // and every connected client's memory.
    expect(payload.truncated).toBe(true);
    expect(JSON.stringify(payload).length).toBeLessThan(AI_RAW_CAP_BYTES * 2);
  });
});

describe("the valve holds for values that cannot be SERIALIZED", () => {
  // The hole this closes: the catch handler used to hand the offending value straight to
  // `boundRawPayload`, which walks and JSON-stringifies it — re-triggering the very failure
  // it was catching, from inside the catch. So "never throws" was false for a whole class
  // of input, and the run died with a provider error instead of an `ai_raw`.
  //
  // All three arrive from adapter code, not from `JSON.parse`, which is exactly where a
  // forwarded SDK object comes from: Node error objects and streams carry cycles, and a
  // numeric field can arrive as a BigInt.
  const hostile: Array<[string, unknown]> = [
    ["a BigInt", { count: 1n }],
    [
      "a circular reference",
      (() => {
        const o: Record<string, unknown> = { a: 1 };
        o.self = o;
        return o;
      })(),
    ],
    [
      "a toJSON that throws",
      {
        toJSON() {
          throw new Error("nope");
        },
      },
    ],
  ];

  for (const [name, value] of hostile) {
    it(`survives ${name}`, async () => {
      const outcome = await run([{ t: "raw", value } as ProviderEvent, ...text("recovered")]);

      expect(outcome.outcome).toBe("finished");
      expect(rawEntries()).toHaveLength(1);
    });

    it(`says WHY it could not record ${name}`, async () => {
      await run([{ t: "raw", value } as ProviderEvent, ...text("recovered")]);

      // A silent `{}` would read as "the provider sent nothing", which is a different
      // and much more confusing fact than "this could not be serialized".
      expect(JSON.stringify(rawEntries()[0]?.payload)).toMatch(/unserializable/);
    });
  }

  it("still records the ordinary case in full, so the guard is not a blanket", async () => {
    await run([{ t: "raw", value: { plain: "data" } } as ProviderEvent, ...text("hi")]);

    expect(JSON.stringify(rawEntries()[0]?.payload)).toContain("plain");
    expect(JSON.stringify(rawEntries()[0]?.payload)).not.toMatch(/unserializable/);
  });
});

describe("the valve's boundary, stated so it is not widened by accident", () => {
  it("catches a mapping failure INSIDE the normalizer", () => {
    const normalizer = new LoopNormalizer({ sessionId: "45", aiRunId: "1", requestedBy: "7" });

    // `map` promises never to throw, and this is that promise: an unhandled shape comes
    // back as `ai_raw` carrying the reason.
    const out = normalizer.map({ t: "raw", value: { count: 1n } } as ProviderEvent, 1);

    expect(out[0]?.type).toBe("ai_raw");
    expect(JSON.stringify(out[0]?.payload)).toMatch(/unserializable/);
  });

  it("FAILS the run when a ProviderEvent's own property access throws", async () => {
    const hostile = { t: "block_stop", index: 0 } as Record<string, unknown>;
    Object.defineProperty(hostile, "block", {
      get() {
        throw new Error("booby-trapped event");
      },
      enumerable: true,
    });

    const outcome = await run([hostile as unknown as ProviderEvent, ...text("unreached")]);

    // DELIBERATE, and the distinction is where the value comes from. `ai_raw` exists for
    // things a PROVIDER sends, and every adapter builds its events from parsed JSON — which
    // cannot produce a throwing getter. An event that explodes on property access therefore
    // means adapter code built it that way, and that is OUR bug: the loop reads `.block`
    // before the normalizer sees the event, and wrapping that read in a catch-all would
    // disguise a real defect in block accumulation as a provider surprise nobody reads.
    //
    // The realistic hazards are serialization-time (BigInt, cycles, a throwing toJSON) and
    // are covered above; those pass property access and only fail when stringified.
    expect(outcome.outcome).toBe("failed");
  });
});
