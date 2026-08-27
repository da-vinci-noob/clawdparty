#!/usr/bin/env node
// Capture REAL Bedrock ConverseStream transcripts, so the Converse→ProviderEvent mapper is
// written against bytes Bedrock actually sent rather than bytes its documentation describes.
//
//   node --import tsx scripts/capture_converse.ts                    # print a summary
//   node --import tsx scripts/capture_converse.ts --write            # write the fixtures
//   node --import tsx scripts/capture_converse.ts --write --only=x   # just scenario x
//
// WHY A LIVE CAPTURE. An earlier version asserted that OpenAI models on Bedrock go
// through the OpenAI-compatible Chat Completions surface and that each model family
// therefore needs its own adapter. Both were wrong, and reading more documentation would
// not have revealed it — one `converse` call did. The same risk applies to the stream event
// vocabulary, which is the one thing still unverified by execution: Bedrock
// REPORTS `responseStreamingSupported: true`, and aws-cli 2.36.14 has no `converse-stream`
// subcommand to check it with.
//
// NOT BYTE-STABLE, unlike scripts/capture_fixture.ts. That one drives a ScriptedAdapter, so
// regeneration is deterministic. This one asks a real model, so the text differs every run.
// What must stay stable is the event VOCABULARY and its ordering — which is what
// `test/providers/converse_fixture.test.ts` asserts, and what the mapper consumes.
//
// COST is a few dozen output tokens per scenario. It bills the account behind
// HARNESS_AWS_PROFILE.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type ConverseStreamOutput,
  type Message,
  type ToolConfiguration,
} from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-provider-ini";

const FIXTURE_DIR = fileURLToPath(new URL("../test/fixtures/converse/", import.meta.url));

/** The tool the tool-calling scenario offers. Shaped like the harness's own `read` tool so
 *  the captured `toolUse` deltas exercise the real partial-JSON accumulation path. */
const TOOL_CONFIG: ToolConfiguration = {
  tools: [
    {
      toolSpec: {
        name: "read_file",
        description: "Read a file from disk and return its contents.",
        inputSchema: {
          json: {
            type: "object",
            properties: { path: { type: "string", description: "Absolute path" } },
            required: ["path"],
          },
        },
      },
    },
  ],
};

interface Scenario {
  name: string;
  modelId: string;
  messages: Message[];
  toolConfig?: ToolConfiguration;
  maxTokens: number;
}

// Two vendors × two shapes. OpenAI and Nova are the two families measured to support tool
// use through Converse; a text turn and a tool turn are the only two stream shapes
// the loop has to understand.
const SCENARIOS: Scenario[] = [
  {
    name: "openai-text",
    modelId: "us.openai.gpt-5.6-sol",
    // 40 was not enough to REACH the answer: the redacted reasoning block bills against the
    // same output budget, so the turn stopped at `max_tokens` mid-reasoning with no visible
    // text. A maxTokens default tuned for Anthropic would truncate these models
    // systematically, and the symptom is an empty reply rather than a short one.
    messages: [
      { role: "user", content: [{ text: "Name three primary colours, comma separated." }] },
    ],
    maxTokens: 300,
  },
  {
    name: "openai-tool-use",
    modelId: "us.openai.gpt-5.6-sol",
    messages: [
      { role: "user", content: [{ text: "Read the file /tmp/notes.txt using your tool." }] },
    ],
    toolConfig: TOOL_CONFIG,
    maxTokens: 200,
  },
  {
    name: "nova-text",
    modelId: "us.amazon.nova-lite-v1:0",
    // Generous budget so the turn ends NATURALLY. At 40 tokens Nova ran out and stopped with
    // `max_tokens`, which made the common case — a completed turn — the one shape the
    // fixtures did not cover.
    messages: [
      { role: "user", content: [{ text: "Name three primary colours, comma separated." }] },
    ],
    maxTokens: 300,
  },
  {
    name: "nova-max-tokens",
    modelId: "us.amazon.nova-lite-v1:0",
    // Deliberately truncated. `max_tokens` is a stop reason `loop/stop_reasons.ts` acts on,
    // and it is worth having a real example rather than a hand-written one.
    messages: [{ role: "user", content: [{ text: "Write a long paragraph about the sea." }] }],
    maxTokens: 20,
  },
  {
    name: "nova-tool-use",
    modelId: "us.amazon.nova-lite-v1:0",
    messages: [
      { role: "user", content: [{ text: "Read the file /tmp/notes.txt using your tool." }] },
    ],
    toolConfig: TOOL_CONFIG,
    maxTokens: 200,
  },
  {
    name: "deepseek-reasoning",
    // The third reasoning carrier: PLAINTEXT `reasoningContent.text` deltas, which
    // neither OpenAI (encrypted bytes) nor Nova (inline <thinking> in ordinary text) produce.
    // No toolConfig — R1 supports no tools on Bedrock at all.
    modelId: "us.deepseek.r1-v1:0",
    messages: [
      { role: "user", content: [{ text: "What is 17 * 3? Answer with just the number." }] },
    ],
    // R1 reasons at length and reasoning bills the SAME output budget as the answer, so a
    // budget tuned for a one-word reply spends it all thinking and returns no answer — 300
    // produced 947 characters of reasoning and empty text.
    maxTokens: 800,
  },
];

interface Capture {
  provenance: {
    model_id: string;
    region: string;
    captured_at: string;
    scenario: string;
    // Deliberately NOT the AWS account id: a fixture is committed, and the account behind a
    // developer's SSO profile is infrastructure detail the mapper does not need.
    note: string;
  };
  events: ConverseStreamOutput[];
}

async function capture(
  client: BedrockRuntimeClient,
  scenario: Scenario,
  region: string,
): Promise<Capture> {
  const res = await client.send(
    new ConverseStreamCommand({
      modelId: scenario.modelId,
      messages: scenario.messages,
      inferenceConfig: { maxTokens: scenario.maxTokens },
      ...(scenario.toolConfig ? { toolConfig: scenario.toolConfig } : {}),
    }),
  );

  const events: ConverseStreamOutput[] = [];
  for await (const event of res.stream ?? []) {
    events.push(event);
  }

  return {
    provenance: {
      model_id: scenario.modelId,
      region,
      captured_at: new Date().toISOString(),
      scenario: scenario.name,
      note: "Captured live via ConverseStreamCommand. Text content varies per capture; the event vocabulary and ordering are what tests assert.",
    },
    events,
  };
}

/** The kinds present, in arrival order, deduplicated consecutively — the shape a mapper
 *  must handle, and the part of a capture that is comparable across runs. */
function vocabulary(events: ConverseStreamOutput[]): string[] {
  const kinds = events.flatMap((e) => Object.keys(e));
  return kinds.filter((k, i) => k !== kinds[i - 1]);
}

/**
 * Rewrite byte payloads as tagged base64 before serializing.
 *
 * `reasoningContent.redactedContent` arrives as a Uint8Array — OpenAI models on Bedrock send
 * their reasoning back encrypted, to be replayed on the next turn but never displayed.
 * `JSON.stringify` turns a Uint8Array into `{"0":114,"1":115,…}`, which is both 24KB of
 * unreadable diff AND a shape the SDK never produces. A mapper test fed that object would be
 * exercising a type that cannot occur at runtime — the seam-does-not-match-production trap.
 * So the tag is explicit and `loadCapture` in the test helper rehydrates it.
 */
export function encodeBytes(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { __bytes_b64: Buffer.from(value).toString("base64") };
  }
  if (Array.isArray(value)) {
    return value.map(encodeBytes);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeBytes(v)]));
  }
  return value;
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const profile = process.env.HARNESS_AWS_PROFILE ?? process.env.AWS_PROFILE;
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-west-2";

  const client = new BedrockRuntimeClient({
    region,
    ...(profile ? { credentials: fromIni({ profile }) } : {}),
  });

  if (write) {
    mkdirSync(FIXTURE_DIR, { recursive: true });
  }

  // Re-capturing every scenario to add one rewrites four fixtures with different model text,
  // which buries the new file in noise. `--only=` narrows it.
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);
  for (const scenario of SCENARIOS.filter((s) => !only || s.name === only)) {
    let result: Capture;
    try {
      result = await capture(client, scenario, region);
    } catch (err) {
      // A model the account cannot serve must not abort the other captures — an entitlement
      // gap is a finding, not a crash.
      process.stderr.write(
        `${scenario.name}: FAILED — ${err instanceof Error ? err.message : String(err)}\n`,
      );
      continue;
    }

    const path = join(FIXTURE_DIR, `${scenario.name}.json`);
    const body = `${JSON.stringify(encodeBytes(result), null, 2)}\n`;
    process.stdout.write(
      `${scenario.name.padEnd(18)} ${result.events.length} events  vocabulary: ${vocabulary(result.events).join(" → ")}\n`,
    );
    if (write) {
      writeFileSync(path, body);
      process.stdout.write(`  wrote ${path}\n`);
    } else if (existsQuiet(path)) {
      const before = vocabulary((JSON.parse(readFileSync(path, "utf8")) as Capture).events);
      const after = vocabulary(result.events);
      if (before.join(",") !== after.join(",")) {
        process.stdout.write(
          `  VOCABULARY CHANGED since the committed fixture:\n    was ${before.join(" → ")}\n`,
        );
      }
    }
  }
}

function existsQuiet(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

await main();
