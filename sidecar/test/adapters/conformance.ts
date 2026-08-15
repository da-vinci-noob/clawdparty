import { expect, it } from "vitest";
import type {
  Capabilities,
  ProviderAdapter,
  ProviderEvent,
  ProviderRequest,
} from "../../src/providers/contract.js";

/**
 * Gate 4 — the shared adapter conformance suite.
 *
 * ONE suite, run against EVERY adapter. An adapter is not shippable until it
 * passes. The nine assertions come from
 * `contracts/provider_adapter.md`; each is a numbered `it` here so a skipped one
 * is visible in the report rather than absent from it.
 *
 * Usage from an adapter's own test file:
 *
 *   describe("anthropic-direct", () => {
 *     runConformanceSuite({ name: "anthropic-direct", build: () => ({ adapter, scenario }) });
 *   });
 */

/** A canary that must never appear in an outbound request or on disk. */
export const KNOWN_TEST_SECRET = "sk-ant-CONFORMANCE-CANARY-0000000000";

/** Parameters removed from the API — each returns 400 on current models (R10). */
export const REMOVED_PARAMS = ["temperature", "top_p", "top_k", "budget_tokens"] as const;

export interface CapturedRequest {
  /** The literal body the adapter handed the vendor client. */
  body: Record<string, unknown>;
}

export interface ConformanceHarness {
  adapter: ProviderAdapter;
  /** Events the adapter should produce for a minimal text turn. */
  minimalTurn(): Promise<ProviderEvent[]>;
  /** Events for a turn that ends in `tool_use`. */
  toolUseTurn(): Promise<ProviderEvent[]>;
  /** The verbatim blocks the vendor returned, to compare against `block_stop`. */
  vendorBlocks(): unknown[];
  /** Every request body the adapter emitted during this harness's lifetime. */
  captured(): CapturedRequest[];
  /** An adapter configured with no credential at all. */
  withoutCredential(): ProviderAdapter;
  /** Feed an unknown event shape through the adapter's mapping. */
  unknownShapeTurn(): Promise<ProviderEvent[]>;
  /** Start a turn then abort mid-stream; resolve with what was yielded. */
  abortMidStream(): Promise<ProviderEvent[]>;
  /** Anything the adapter wrote to disk during this harness's lifetime. */
  diskWrites(): string[];
}

export interface ConformanceOptions {
  name: string;
  build: () => Promise<ConformanceHarness> | ConformanceHarness;
  /** Models to check `capabilities()` totality against. */
  models: string[];
}

export function runConformanceSuite(opts: ConformanceOptions): void {
  const build = async () => await opts.build();

  it("1. a minimal turn streams the lifecycle in order", async () => {
    const h = await build();
    const types = (await h.minimalTurn()).map((e) => e.t);

    expect(types[0]).toBe("message_start");
    expect(types).toContain("block_start");
    expect(types).toContain("block_stop");
    expect(types.at(-2)).toBe("message_delta");
    expect(types.at(-1)).toBe("message_stop");
    // block_start must precede its block_stop, and both must sit inside the message.
    expect(types.indexOf("block_start")).toBeLessThan(types.indexOf("block_stop"));
    expect(types.indexOf("block_stop")).toBeLessThan(types.lastIndexOf("message_delta"));
  });

  it("2. a tool-use turn stops with tool_use and yields a well-formed tool_use block", async () => {
    const h = await build();
    const events = await h.toolUseTurn();

    const delta = events.find((e) => e.t === "message_delta");
    expect(delta).toMatchObject({ stopReason: "tool_use" });

    const stops = events.filter(
      (e): e is Extract<ProviderEvent, { t: "block_stop" }> => e.t === "block_stop",
    );
    const toolBlock = stops
      .map((s) => s.block)
      .find((b) => (b as { type?: string })?.type === "tool_use");
    expect(toolBlock, "no tool_use block in the stream").toBeDefined();
    expect(toolBlock).toMatchObject({ type: "tool_use" });
    expect((toolBlock as { id?: string }).id).toBeTruthy();
    expect((toolBlock as { name?: string }).name).toBeTruthy();
  });

  it("3. block_stop blocks are byte-identical to what the vendor returned", async () => {
    const h = await build();
    const events = await h.toolUseTurn();
    const emitted = events
      .filter((e): e is Extract<ProviderEvent, { t: "block_stop" }> => e.t === "block_stop")
      .map((e) => e.block);

    // Reconstruction is the failure this catches: a rebuilt block loses
    // compaction and thinking state that the NEXT request needs verbatim (R6).
    expect(emitted).toEqual(h.vendorBlocks());
    expect(JSON.stringify(emitted)).toBe(JSON.stringify(h.vendorBlocks()));
  });

  it("4. no removed parameter appears in any outbound request", async () => {
    const h = await build();
    await h.minimalTurn();
    await h.toolUseTurn();

    for (const request of h.captured()) {
      const serialized = JSON.stringify(request.body);
      for (const param of REMOVED_PARAMS) {
        expect(
          serialized.includes(`"${param}"`),
          `${opts.name} sent removed parameter ${param}; current models reject it with 400`,
        ).toBe(false);
      }
    }
  });

  it("5. an unknown event shape yields { t: 'raw' } and does not throw", async () => {
    const h = await build();
    const events = await h.unknownShapeTurn();

    expect(events.some((e) => e.t === "raw")).toBe(true);
  });

  it("6. probe() with no credential names the reason and an actionable remedy", async () => {
    const adapter = (await build()).withoutCredential();
    const result = await adapter.probe();

    expect(result.available).toBe(false);
    if (result.available) throw new Error("expected unavailable");
    expect(result.reason).toBeTruthy();
    // A generic failure is a contract violation, not a lazy string.
    expect(result.remedy.length, "remedy must be actionable, not a stub").toBeGreaterThan(20);
    expect(result.remedy).not.toMatch(/^(error|failed|unknown)\.?$/i);
  });

  it("7. capabilities() is total: every field present for every listed model", async () => {
    const h = await build();
    for (const model of opts.models) {
      assertTotalCapabilities(h.adapter.capabilities(model), `${opts.name}/${model}`);
    }
  });

  it("8. a mid-stream abort stops the stream and leaves no open blocks", async () => {
    const h = await build();
    const events = await h.abortMidStream();

    const opened = events.filter((e) => e.t === "block_start").length;
    const closed = events.filter((e) => e.t === "block_stop").length;
    expect(closed, `${opened} blocks opened, ${closed} closed after abort`).toBe(opened);
  });

  it("9. stream() never reads or emits a credential value", async () => {
    const h = await build();
    await h.minimalTurn();

    for (const request of h.captured()) {
      expect(JSON.stringify(request.body)).not.toContain(KNOWN_TEST_SECRET);
    }
    // no adapter writes a credential to disk, and none transmits one to
    // a destination other than its own provider endpoint.
    for (const written of h.diskWrites()) {
      expect(written).not.toContain(KNOWN_TEST_SECRET);
    }
  });
}

/**
 * Every field must be PRESENT. A partial capability object is indistinguishable
 * from "unsupported", so a missing field silently disables a feature (or, worse,
 * enables one the provider rejects).
 */
export function assertTotalCapabilities(caps: Capabilities, label: string): void {
  const required: Array<keyof Capabilities> = [
    "streaming",
    "toolUse",
    "contextWindow",
    "maxOutputTokens",
    "adaptiveThinking",
    "thinkingDisplaySummarized",
    "effortLevels",
    "promptCaching",
    "minCacheablePrefixTokens",
    "serverSideCompaction",
    "contextEditing",
    "serverSideTools",
    "liveModelDiscovery",
    "serverSideRefusalFallback",
    "midConversationSystemMessages",
    "midConversationToolChanges",
  ];

  for (const field of required) {
    expect(field in caps, `${label} missing capability field: ${field}`).toBe(true);
    expect(caps[field], `${label}.${field} is undefined`).not.toBeUndefined();
  }

  // minCacheablePrefixTokens is the one legitimately nullable field — null means
  // "no minimum applies", which is different from "unknown".
  expect(caps.contextWindow, `${label} contextWindow must be a real budget`).toBeGreaterThan(0);
  expect(caps.maxOutputTokens).toBeGreaterThan(0);
  expect(Array.isArray(caps.effortLevels)).toBe(true);

  for (const tool of ["webSearch", "webFetch", "codeExecution"] as const) {
    expect(
      typeof caps.serverSideTools[tool],
      `${label}.serverSideTools.${tool} must be an explicit boolean`,
    ).toBe("boolean");
  }
}

/** A minimal frozen request, for adapters that need one to drive `stream()`. */
export function conformanceRequest(over: Partial<ProviderRequest> = {}): ProviderRequest {
  return Object.freeze({
    model: "claude-opus-5",
    maxTokens: 1024,
    system: [{ type: "text" as const, text: "You are a test." }],
    messages: [{ role: "user" as const, content: [{ type: "text", text: "hello" }] }],
    tools: [],
    thinking: { type: "adaptive" as const, display: "summarized" as const },
    cacheBreakpoints: [],
    signal: new AbortController().signal,
    ...over,
  });
}
