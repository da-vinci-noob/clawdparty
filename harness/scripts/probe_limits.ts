#!/usr/bin/env node
// Measure each Converse model's REAL output-token ceiling.
//
//   node --import tsx scripts/probe_limits.ts            # print the table
//   node --import tsx scripts/probe_limits.ts --write     # write the fixture
//
// WHY A PROBE. `ListFoundationModels` reports modality and streaming support and says nothing
// about the output ceiling, so `bedrock_converse.ts` used a flat, deliberately-modest 8192 —
// safe, because an over-limit `maxTokens` is a run-killing ValidationException, but wrong by up
// to 16x on the models that reason.
//
// The measurement is ONE REQUEST PER MODEL and costs nothing: Bedrock rejects an over-limit
// `maxTokens` with the ceiling IN THE MESSAGE ("exceeds the model limit of 32768"), and a
// validation rejection generates no tokens. No binary search, no inference.
//
// It bills the account behind HARNESS_AWS_PROFILE only for the models that ACCEPT the request,
// which should be none — an acceptance means the ceiling is at or above ABSURD_MAX_TOKENS and is
// reported as such rather than guessed.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BedrockRuntimeClient, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-provider-ini";

const FIXTURE_DIR = fileURLToPath(new URL("../test/fixtures/converse/", import.meta.url));

/** Higher than any plausible ceiling, so every model answers with its own limit. */
const ABSURD_MAX_TOKENS = 1_000_000;

/** The limit Bedrock names in its refusal, or null when it named none. */
function ceilingFrom(message: string): number | null {
  const found = /model limit of (\d+)/.exec(message);
  return found?.[1] ? Number(found[1]) : null;
}

interface Row {
  profile_id: string;
  max_output_tokens: number | null;
  /** Verbatim, so a message-format change is visible rather than silently unparsed. */
  message: string;
}

async function probe(client: BedrockRuntimeClient, profileId: string): Promise<Row> {
  try {
    const res = await client.send(
      new ConverseStreamCommand({
        modelId: profileId,
        messages: [{ role: "user", content: [{ text: "hi" }] }],
        inferenceConfig: { maxTokens: ABSURD_MAX_TOKENS },
      }),
    );
    for await (const _event of res.stream ?? []) {
      // Drained: an ACCEPTED absurd ceiling means there is no ceiling to learn here.
    }
    return { profile_id: profileId, max_output_tokens: null, message: "accepted (no limit named)" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { profile_id: profileId, max_output_tokens: ceilingFrom(message), message };
  }
}

interface Matrix {
  rows: Array<{ profile_id: string }>;
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const profile = process.env.HARNESS_AWS_PROFILE ?? process.env.AWS_PROFILE;
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-west-2";
  const client = new BedrockRuntimeClient({
    region,
    ...(profile ? { credentials: fromIni({ profile }) } : {}),
  });

  // The same population the model matrix measured, so the two fixtures describe one model set.
  const matrix = JSON.parse(readFileSync(`${FIXTURE_DIR}model_matrix.json`, "utf8")) as Matrix;

  const rows: Row[] = [];
  for (const { profile_id } of matrix.rows) {
    const row = await probe(client, profile_id);
    rows.push(row);
    process.stdout.write(
      `${profile_id.padEnd(42)} ${String(row.max_output_tokens ?? "?").padStart(7)}  ${
        row.max_output_tokens === null ? row.message.slice(0, 70) : ""
      }\n`,
    );
  }

  if (write) {
    const body = `${JSON.stringify({ measured_at: new Date().toISOString(), region, note: "Each row is Bedrock's own refusal of an over-limit maxTokens; the ceiling is quoted in its message. One request per model, none of them billed.", rows }, null, 2)}\n`;
    writeFileSync(`${FIXTURE_DIR}model_limits.json`, body);
    process.stdout.write(`\nwrote ${FIXTURE_DIR}model_limits.json\n`);
  }
}

await main();
