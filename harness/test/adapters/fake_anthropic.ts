import type { ProviderAdapter, ProviderEvent } from "../../src/providers/contract.js";
import type { CapturedRequest, ConformanceHarness } from "./conformance.js";
import { conformanceRequest } from "./conformance.js";

/**
 * A fake Anthropic-family client and a conformance harness built on it, shared by all three
 * Anthropic-family adapters.
 *
 * R3 is why one fake serves three adapters: after construction, the first-party client and
 * the Bedrock Mantle client expose the SAME `messages.stream` surface and emit the same
 * events. The adapters differ in AUTHENTICATION, CAPABILITIES and DESTINATION — none of
 * which the stream fake is modelling — so a per-adapter copy of this file would be three
 * copies of the same 100 lines, drifting independently.
 *
 * Faked at the SDK boundary and no lower. The adapter's own mapping is what is under test;
 * faking HTTP would test the SDK, and faking the mapping would test the fake.
 */

export const TEXT_BLOCK = { type: "text", text: "hello there", citations: null };
export const THINKING_BLOCK = {
  type: "thinking",
  thinking: "considering",
  signature: "sig-abc",
};
export const TOOL_BLOCK = {
  type: "tool_use",
  id: "toolu_01",
  name: "bash",
  input: { command: "ls" },
};

export const MODEL_LIST = {
  data: [
    {
      id: "claude-opus-5",
      display_name: "Claude Opus 5",
      type: "model" as const,
      created_at: "2026-01-01T00:00:00Z",
      max_input_tokens: 1_000_000,
      max_tokens: 64_000,
      capabilities: {
        code_execution: { supported: true },
        context_management: {
          clear_thinking_20251015: { supported: true },
          clear_tool_uses_20250919: { supported: true },
        },
        effort: {
          low: { supported: true },
          medium: { supported: true },
          high: { supported: true },
          xhigh: { supported: true },
          max: { supported: true },
        },
        thinking: {
          supported: true,
          types: { adaptive: { supported: true }, enabled: { supported: false } },
        },
      },
    },
  ],
};

export type StreamEvent = Record<string, unknown>;

/** The vendor event sequence for a turn made of `blocks`, ending in `stopReason`. */
export function lifecycle(blocks: unknown[], stopReason: string): StreamEvent[] {
  const events: StreamEvent[] = [{ type: "message_start", message: { model: "claude-opus-5" } }];

  blocks.forEach((block, index) => {
    events.push({ type: "content_block_start", index, content_block: block });
    const b = block as { type: string; text?: string; thinking?: string };

    if (b.type === "text") {
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: b.text },
      });
    } else if (b.type === "thinking") {
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: b.thinking },
      });
      // signature_delta carries no harness-visible text; it rides inside the block.
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: "sig-abc" },
      });
    } else {
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' },
      });
    }
    events.push({ type: "content_block_stop", index });
  });

  events.push({
    type: "message_delta",
    delta: { stop_reason: stopReason },
    usage: {
      input_tokens: 12,
      output_tokens: 34,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 6,
    },
  });
  events.push({ type: "message_stop" });
  return events;
}

export interface FakeOptions {
  events: StreamEvent[];
  blocks: unknown[];
  /** Stop yielding after N events, simulating an abort. */
  cutAfter?: number;
  listThrows?: { status: number } | Error;
}

export interface FakeClientOptions {
  /** Where this adapter's requests go, so assertion 11 can check the destination. */
  url: string;
  /** Headers the adapter would set, so credential transport can be checked. */
  headers: () => Record<string, string>;
}

/**
 * A client with the `models.list` + `messages.stream` surface the adapters use.
 *
 * `currentMessage` accumulates as blocks complete, mirroring the real SDK — so
 * `content[index]` is populated by the time `content_block_stop` is seen. Getting that
 * wrong would make assertion 3 (blocks are byte-identical) pass against `undefined`.
 */
export function fakeClient(
  options: FakeOptions,
  captured: CapturedRequest[],
  transport: FakeClientOptions,
): unknown {
  return {
    models: {
      list: async () => {
        if (options.listThrows) throw options.listThrows;
        return MODEL_LIST;
      },
    },
    messages: {
      stream: (body: Record<string, unknown>) => {
        captured.push({ body, url: transport.url, headers: transport.headers() });
        const handle = {
          currentMessage: { content: [] as unknown[] },
          async *[Symbol.asyncIterator]() {
            let emitted = 0;
            for (const event of options.events) {
              if (options.cutAfter !== undefined && emitted >= options.cutAfter) return;
              if (event.type === "content_block_start") {
                handle.currentMessage.content[event.index as number] =
                  options.blocks[event.index as number];
              }
              emitted += 1;
              yield event;
            }
          },
        };
        return handle;
      },
    },
  };
}

export async function collect(iterable: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

export interface HarnessSpec {
  /** Build the adapter under test with a given fake client. */
  build: (client: unknown, opts: { withoutCredential?: boolean }) => ProviderAdapter;
  transport: FakeClientOptions;
  allowedHosts: string[];
}

/**
 * The conformance harness, parameterized by adapter. Every adapter gets the SAME turns and
 * the same abort point, so a difference in the suite's result is a difference in the
 * adapter rather than in how it was exercised.
 */
export function anthropicHarness(spec: HarnessSpec): ConformanceHarness {
  const captured: CapturedRequest[] = [];
  const blocks = [THINKING_BLOCK, TEXT_BLOCK, TOOL_BLOCK];

  const withFake = (over: Partial<FakeOptions> = {}, withoutCredential = false) =>
    spec.build(
      fakeClient(
        { events: lifecycle(blocks, "tool_use"), blocks, ...over },
        captured,
        spec.transport,
      ),
      { withoutCredential },
    );

  const adapter = withFake();

  return {
    adapter,
    async minimalTurn() {
      const textOnly = [TEXT_BLOCK];
      const a = withFake({ events: lifecycle(textOnly, "end_turn"), blocks: textOnly });
      return collect(a.stream(conformanceRequest()));
    },
    async toolUseTurn() {
      await adapter.listModels().catch(() => []);
      return collect(adapter.stream(conformanceRequest()));
    },
    vendorBlocks() {
      return blocks;
    },
    captured() {
      return captured;
    },
    withoutCredential() {
      return withFake({ events: [], blocks: [] }, true);
    },
    async unknownShapeTurn() {
      const a = withFake({ events: [{ type: "some_future_event_type", payload: 1 }] });
      return collect(a.stream(conformanceRequest()));
    },
    async abortMidStream() {
      // Cut immediately after the first block closes: message_start,
      // content_block_start, delta, signature delta, content_block_stop = 5.
      const a = withFake({ events: lifecycle(blocks, "tool_use"), cutAfter: 5 });
      return collect(a.stream(conformanceRequest()));
    },
    diskWrites() {
      return [];
    },
    allowedHosts() {
      return spec.allowedHosts;
    },
  };
}
