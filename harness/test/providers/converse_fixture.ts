import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";

/**
 * Load a captured ConverseStream transcript, rehydrating byte payloads to `Uint8Array`.
 *
 * The rehydration is the point. `reasoningContent.redactedContent` arrives from the SDK as a
 * Uint8Array; JSON cannot hold one, so `capture_converse.ts` writes `{__bytes_b64}`. A test
 * that fed the mapper the tagged object instead would be exercising a shape the SDK never
 * produces — the same class of mistake as a test seam placed outside the code it is meant to
 * cover.
 */

const DIR = fileURLToPath(new URL("../fixtures/converse/", import.meta.url));

export interface ConverseCapture {
  provenance: {
    model_id: string;
    region: string;
    captured_at: string;
    scenario: string;
    note: string;
  };
  events: ConverseStreamOutput[];
}

export type ConverseScenario =
  | "openai-text"
  | "openai-tool-use"
  | "nova-text"
  | "nova-tool-use"
  | "nova-max-tokens";

export const SCENARIOS: ConverseScenario[] = [
  "openai-text",
  "openai-tool-use",
  "nova-text",
  "nova-tool-use",
  "nova-max-tokens",
];

function rehydrate(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(rehydrate);
  }
  if (value !== null && typeof value === "object") {
    const tagged = value as { __bytes_b64?: string };
    if (typeof tagged.__bytes_b64 === "string") {
      return new Uint8Array(Buffer.from(tagged.__bytes_b64, "base64"));
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rehydrate(v)]));
  }
  return value;
}

export function loadCapture(scenario: ConverseScenario): ConverseCapture {
  const raw = JSON.parse(readFileSync(`${DIR}${scenario}.json`, "utf8")) as unknown;
  return rehydrate(raw) as ConverseCapture;
}

/** An async iterable over a capture's events, so a fixture can drive code that expects the
 *  SDK's `res.stream`. */
export async function* replay(scenario: ConverseScenario): AsyncGenerator<ConverseStreamOutput> {
  for (const event of loadCapture(scenario).events) {
    yield event;
  }
}

/** Consecutive-deduplicated event kinds, in arrival order. */
export function vocabulary(events: ConverseStreamOutput[]): string[] {
  const kinds = events.flatMap((e) => Object.keys(e));
  return kinds.filter((k, i) => k !== kinds[i - 1]);
}
