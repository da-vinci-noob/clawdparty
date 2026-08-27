#!/usr/bin/env node
// Probe EVERY text-capable Bedrock inference profile through Converse and record what each
// one actually does. Writes the matrix needed to decide how tool-use capability is
// determined, and what may be enumerated at all.
//
//   node --import tsx scripts/probe_converse_models.ts [--write]
//
// WHY A MATRIX AND NOT A CAPABILITY TABLE COPIED FROM DOCS. Bedrock exposes NO tool-support
// flag in `ListFoundationModels`, and the two families first measured disagreed with each
// other: `us.openai.gpt-5.6-sol` and `us.amazon.nova-lite-v1:0` returned
// `stopReason: tool_use`, while `us.meta.llama3-3-70b-instruct-v1:0` returned `end_turn` with
// no tool call. A table asserting "Bedrock supports tool use" would be wrong for a third of
// the catalogue, and there is precedent for a capability table whose passing test defended
// the defect.
//
// COST: two small requests per model. It bills the account behind HARNESS_AWS_PROFILE.

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
} from "@aws-sdk/client-bedrock";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type ConverseStreamOutput,
  type ToolConfiguration,
} from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-provider-ini";

const OUT = fileURLToPath(new URL("../test/fixtures/converse/model_matrix.json", import.meta.url));

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

interface Row {
  profile_id: string;
  vendor: string;
  /** Whether a plain STREAMING text turn produced any visible text. */
  text: "ok" | "empty" | string;
  /**
   * Tool use is TWO capabilities on Bedrock, not one, and the distinction decides whether a
   * model can drive this harness at all.
   *
   * Measured: `us.meta.llama3-3-70b-instruct-v1:0`, `us.writer.palmyra-x5-v1:0` and
   * `us.mistral.pixtral-large-2502-v1:0` accept a `toolConfig` on `Converse` — palmyra and
   * pixtral even return `stopReason: tool_use` — and are REFUSED on `ConverseStream` with
   * "This model doesn't support tool use in streaming mode." A single `toolUse` boolean cannot
   * express that, and `Capabilities` in `providers/contract.ts` currently has exactly that.
   */
  tool_use_stream: "yes" | "no" | string;
  tool_use_nonstream: "yes" | "no" | string;
  stop_reason: string | null;
  vocabulary: string[];
  /** Which of the three reasoning carriers the model uses, if any. */
  reasoning: "redacted_bytes" | "reasoning_text" | "inline_thinking_markup" | null;
}

function vendorOf(id: string): string {
  const parts = id.split(".");
  return parts[0] && ["us", "eu", "apac", "global", "us-gov"].includes(parts[0])
    ? (parts[1] ?? "?")
    : (parts[0] ?? "?");
}

const TOOL_PROMPT = "Read the file /tmp/notes.txt using your tool.";

/** Bedrock's refusal messages are the capability answer; keep them short but distinguishable. */
function shortReason(message: string): string {
  if (message.includes("tool use in streaming mode")) return "no:streaming-only-limit";
  if (message.includes("doesn't support tool use")) return "no:unsupported";
  return `error:${message.slice(0, 40)}`;
}

const vocabulary = (events: ConverseStreamOutput[]): string[] => {
  const kinds = events.flatMap((e) => Object.keys(e));
  return kinds.filter((k, i) => k !== kinds[i - 1]);
};

async function drain(
  client: BedrockRuntimeClient,
  modelId: string,
  prompt: string,
  tools: boolean,
): Promise<ConverseStreamOutput[]> {
  const res = await client.send(
    new ConverseStreamCommand({
      modelId,
      messages: [{ role: "user", content: [{ text: prompt }] }],
      // Generous: OpenAI-family reasoning bills against this same budget, and a tight limit
      // stops the turn before any visible text (measured).
      inferenceConfig: { maxTokens: 400 },
      ...(tools ? { toolConfig: TOOL_CONFIG } : {}),
    }),
  );
  const events: ConverseStreamOutput[] = [];
  for await (const event of res.stream ?? []) events.push(event);
  return events;
}

function textOf(events: ConverseStreamOutput[]): string {
  return events
    .flatMap((e) =>
      "contentBlockDelta" in e
        ? [
            (e as { contentBlockDelta: { delta?: { text?: string } } }).contentBlockDelta.delta
              ?.text ?? "",
          ]
        : [],
    )
    .join("");
}

function reasoningShape(events: ConverseStreamOutput[]): Row["reasoning"] {
  for (const e of events) {
    if (!("contentBlockDelta" in e)) continue;
    const delta = (e as { contentBlockDelta: { delta?: Record<string, unknown> } })
      .contentBlockDelta.delta;
    const reasoning = delta?.reasoningContent as
      | { redactedContent?: unknown; text?: unknown }
      | undefined;
    if (reasoning?.redactedContent) return "redacted_bytes";
    if (reasoning?.text) return "reasoning_text";
  }
  return textOf(events).includes("<thinking") ? "inline_thinking_markup" : null;
}

/** Text-capable candidates only: an IMAGE or EMBEDDING model cannot serve an agent turn, so
 *  probing it would only produce a validation error and a bill. */
async function candidates(region: string, profile?: string): Promise<string[]> {
  const control = new BedrockClient({
    region,
    ...(profile ? { credentials: fromIni({ profile }) } : {}),
  });

  const textModels = new Set<string>();
  const models = await control.send(new ListFoundationModelsCommand({}));
  for (const m of models.modelSummaries ?? []) {
    if ((m.outputModalities ?? []).includes("TEXT") && m.responseStreamingSupported && m.modelId) {
      // Match on the model id's tail, since a profile id prefixes a region scope.
      textModels.add(m.modelId);
    }
  }

  const ids: string[] = [];
  let nextToken: string | undefined;
  do {
    const res = await control.send(
      new ListInferenceProfilesCommand({ typeEquals: "SYSTEM_DEFINED", nextToken }),
    );
    for (const p of res.inferenceProfileSummaries ?? []) {
      const id = p.inferenceProfileId;
      if (!id || id.includes("anthropic")) continue;
      // A profile id is "<scope>.<model-id>"; keep it when its model is text+streaming.
      const bare = id.split(".").slice(1).join(".");
      if (textModels.has(bare)) ids.push(id);
    }
    nextToken = res.nextToken;
  } while (nextToken);

  // One profile per model: the us./global. pair of the same model behaves identically, and
  // probing both doubles the bill for no new information.
  const seen = new Set<string>();
  return ids.filter((id) => {
    const bare = id.split(".").slice(1).join(".");
    if (seen.has(bare)) return false;
    seen.add(bare);
    return true;
  });
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const profile = process.env.HARNESS_AWS_PROFILE ?? process.env.AWS_PROFILE;
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-west-2";
  const runtime = new BedrockRuntimeClient({
    region,
    ...(profile ? { credentials: fromIni({ profile }) } : {}),
  });

  const ids = await candidates(region, profile);
  process.stdout.write(
    `probing ${ids.length} text-capable non-Anthropic profiles in ${region}\n\n`,
  );

  const rows: Row[] = [];
  for (const id of ids) {
    const row: Row = {
      profile_id: id,
      vendor: vendorOf(id),
      text: "empty",
      tool_use_stream: "no",
      tool_use_nonstream: "no",
      stop_reason: null,
      vocabulary: [],
      reasoning: null,
    };

    try {
      const plain = await drain(runtime, id, "Name three primary colours, comma separated.", false);
      row.text = textOf(plain).trim() ? "ok" : "empty";
      row.vocabulary = vocabulary(plain);
      row.reasoning = reasoningShape(plain);
    } catch (err) {
      row.text = `error: ${err instanceof Error ? err.name : "unknown"}`;
    }

    try {
      const tools = await drain(runtime, id, TOOL_PROMPT, true);
      const stop = tools.find((e) => "messageStop" in e) as
        | { messageStop: { stopReason?: string } }
        | undefined;
      row.stop_reason = stop?.messageStop.stopReason ?? null;
      row.tool_use_stream = tools.some(
        (e) =>
          ("contentBlockStart" in e &&
            "toolUse" in
              ((e as { contentBlockStart: { start?: object } }).contentBlockStart.start ?? {})) ||
          row.stop_reason === "tool_use",
      )
        ? "yes"
        : "no";
    } catch (err) {
      // The MESSAGE matters, not just the exception name: "doesn't support tool use in
      // streaming mode" is a different answer from "doesn't support tool use", and the first
      // one still leaves the model usable without streaming.
      row.tool_use_stream = err instanceof Error ? shortReason(err.message) : "error";
    }

    // Only worth asking when streaming refused: a model that streams tools needs no fallback.
    if (row.tool_use_stream !== "yes") {
      try {
        const res = await runtime.send(
          new ConverseCommand({
            modelId: id,
            messages: [{ role: "user", content: [{ text: TOOL_PROMPT }] }],
            toolConfig: TOOL_CONFIG,
            inferenceConfig: { maxTokens: 400 },
          }),
        );
        row.tool_use_nonstream =
          res.stopReason === "tool_use" ? "yes" : `accepted:${res.stopReason}`;
      } catch (err) {
        row.tool_use_nonstream = err instanceof Error ? shortReason(err.message) : "error";
      }
    } else {
      row.tool_use_nonstream = "yes";
    }

    rows.push(row);
    process.stdout.write(
      `${id.padEnd(44)} text=${String(row.text).padEnd(6)} tool_stream=${String(row.tool_use_stream).padEnd(16)} tool_nonstream=${String(row.tool_use_nonstream).padEnd(18)} reasoning=${row.reasoning ?? "-"}\n`,
    );
  }

  const byVendor = new Map<string, number>();
  for (const r of rows) byVendor.set(r.vendor, (byVendor.get(r.vendor) ?? 0) + 1);
  process.stdout.write(
    `\nvendors probed: ${[...byVendor].map(([v, n]) => `${v}=${n}`).join(" ")}\n` +
      `tools WHILE streaming: ${rows.filter((r) => r.tool_use_stream === "yes").length}/${rows.length}\n` +
      `tools only without streaming: ${rows.filter((r) => r.tool_use_stream !== "yes" && r.tool_use_nonstream === "yes").length}/${rows.length}\n` +
      `no tools at all: ${rows.filter((r) => r.tool_use_stream !== "yes" && r.tool_use_nonstream !== "yes").length}/${rows.length}\n`,
  );

  if (write) {
    mkdirSync(fileURLToPath(new URL("../test/fixtures/converse/", import.meta.url)), {
      recursive: true,
    });
    writeFileSync(
      OUT,
      `${JSON.stringify(
        {
          provenance: {
            region,
            probed_at: new Date().toISOString(),
            note: "Measured via ConverseStream, one probe per model (text) plus one with a toolConfig. Bedrock exposes no tool-support flag, so this matrix is the only source for it.",
          },
          rows,
        },
        null,
        2,
      )}\n`,
    );
    process.stdout.write(`\nwrote ${OUT}\n`);
  }
}

await main();
