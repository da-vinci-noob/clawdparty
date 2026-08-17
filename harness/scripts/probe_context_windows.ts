#!/usr/bin/env node
// Measure each Converse model's REAL context window.
//
//   node --import tsx scripts/probe_context_windows.ts                    # DRY RUN, sends nothing
//   node --import tsx scripts/probe_context_windows.ts --send [--write]   # actually probe
//
// DRY RUN IS THE DEFAULT, and that is not caution for its own sake — see FILLER_TOKENS below. This
// script has already billed an account it was supposed to leave alone.
//
// WHY A PROBE. `ListInferenceProfiles` reports no context window, so `inferContextWindow` returned
// 1M for five Anthropic families and a flat 200_000 for everything else — an OVER-declaration, which
// is the wrong direction: the context gauge then reads 50% when the model is actually at 78%, and
// the run dies at what looks like two thirds of the bar. Measured on the live API (S8.4):
// `us.meta.llama3-1-8b-instruct-v1:0` answered "This model's maximum context length is 131072
// tokens" while the harness declared 200_000.
//
// The measurement is the same trick `probe_limits.ts` uses for the output ceiling: send a prompt
// bigger than any plausible window and read the number out of Bedrock's refusal. A validation
// rejection generates no tokens, so a refusal costs NOTHING.
//
// WHAT COSTS MONEY, stated because it is the whole reason for `--all`. A model whose window is
// LARGER than the filler ACCEPTS the request and bills for every input token. Llama 4 Scout is
// documented at 3.5M and Nova Premier at 1M, and the three `openai.gpt-5.6-*` profiles have no
// published Bedrock input price here — so those, plus the video model, are skipped by default and
// listed as unmeasured rather than guessed. Raising FILLER_TOKENS above their windows would make
// them refuse for free, at the cost of a request body in the tens of megabytes.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-provider-ini";

const FIXTURE_DIR = fileURLToPath(new URL("../test/fixtures/converse/", import.meta.url));

/**
 * THE SIZING PROBLEM, which has no clean answer and cost money to learn.
 *
 * A refusal is free; an ACCEPTANCE bills for every input token. So the filler must exceed the
 * window — and the window is exactly what is unknown. The first run sized this from documented
 * figures ("above every window in the subset") and was wrong for five models: Palmyra X4/X5 and
 * three Novas accepted ~280k input tokens each and billed for all of them. The token estimate was
 * also ~20% under (350k intended, 280k actual).
 *
 * Going bigger is not simply safer either. At 4M tokens the request body is ~16MB, all 18 uploads
 * did not finish inside ten minutes, and Llama 4 Scout is documented at 3.5M — close enough to the
 * real token count that it might accept and bill for MILLIONS of tokens.
 *
 * So: no default that sends anything. Pick a size deliberately, for one model at a time, knowing
 * that being wrong costs the account behind HARNESS_AWS_PROFILE.
 */
const FILLER_TOKENS = Number(process.env.FILLER_TOKENS ?? 350_000);
const FILLER = "word ".repeat(Math.ceil((FILLER_TOKENS * 4) / 5));

/**
 * Skipped unless `--all`: a window bigger than FILLER_TOKENS means the request is ACCEPTED and the
 * whole input is billed. Documented windows, not measured ones — which is exactly why they are
 * skipped rather than written into the table.
 */
const BILLING_RISK = new Set([
  // only consulted with --allow-billing
  "us.meta.llama4-scout-17b-instruct-v1:0",
  "us.meta.llama4-maverick-17b-instruct-v1:0",
  "us.amazon.nova-premier-v1:0",
  "us.openai.gpt-5.6-sol",
  "us.openai.gpt-5.6-terra",
  "us.openai.gpt-5.6-luna",
  // Video-in, and a text filler tells us nothing about it.
  "us.twelvelabs.pegasus-1-2-v1:0",
]);

/** The window Bedrock names in its refusal, or null when it named none. */
function windowFrom(message: string): number | null {
  // Every wording Bedrock actually produced, measured. Mistral names the window at the END of a
  // sentence that also states the prompt size, so the prompt-size digits must not win.
  const found =
    /maximum context length is (\d+) tokens/i.exec(message) ??
    /with (\d+) maximum context length/i.exec(message) ??
    /context length of (\d+)/i.exec(message);
  return found?.[1] ? Number(found[1]) : null;
}

interface Row {
  profile_id: string;
  context_window: number | null;
  /** Verbatim, so a message-format change is visible rather than silently unparsed. */
  message: string;
}

async function probe(client: BedrockRuntimeClient, profileId: string): Promise<Row> {
  try {
    const res = await client.send(
      new ConverseCommand({
        modelId: profileId,
        messages: [{ role: "user", content: [{ text: FILLER }] }],
        // Minimal, so an acceptance bills for input only.
        inferenceConfig: { maxTokens: 1 },
      }),
    );
    return {
      profile_id: profileId,
      context_window: null,
      message: `ACCEPTED ${FILLER_TOKENS}-token input (window is larger); usage=${JSON.stringify(res.usage)}`,
    };
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { profile_id: profileId, context_window: windowFrom(message), message };
  }
}

interface Matrix {
  rows: Array<{ profile_id: string }>;
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const all = process.argv.includes("--all");
  const send = process.argv.includes("--send");
  const profile = process.env.HARNESS_AWS_PROFILE ?? process.env.AWS_PROFILE;
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-west-2";
  const client = new BedrockRuntimeClient({
    region,
    ...(profile ? { credentials: fromIni({ profile }) } : {}),
  });

  // The same population the other two fixtures describe, so all three cover one model set.
  const matrix = JSON.parse(readFileSync(`${FIXTURE_DIR}model_matrix.json`, "utf8")) as Matrix;
  const rows: Row[] = [];
  const skipped: string[] = [];

  if (!send) {
    const count = matrix.rows.length - (all ? 0 : BILLING_RISK.size);
    const mb = Math.round((FILLER.length / 1_000_000) * 10) / 10;
    process.stdout.write(
      `DRY RUN — nothing sent. Would probe ${count} model(s) with a ${FILLER_TOKENS}-token filler (~${mb}MB per request).
A model whose window EXCEEDS the filler accepts and bills for the whole input.
Re-run with --send when that is what you want.
`,
    );
    return;
  }

  for (const { profile_id } of matrix.rows) {
    if (!all && BILLING_RISK.has(profile_id)) {
      skipped.push(profile_id);
      process.stdout.write(
        `${profile_id.padEnd(44)} ${"skipped".padStart(8)}  would bill on accept\n`,
      );
      continue;
    }
    const row = await probe(client, profile_id);
    rows.push(row);
    process.stdout.write(
      `${profile_id.padEnd(44)} ${String(row.context_window ?? "?").padStart(8)}  ${
        row.context_window === null ? row.message.slice(0, 60) : ""
      }\n`,
    );
  }

  if (write) {
    const body = `${JSON.stringify(
      {
        region,
        filler_tokens: FILLER_TOKENS,
        note: "Each row is Bedrock's own refusal of an over-long input; the window is quoted in its message. A validation rejection generates no tokens, so a measured row is unbilled. `skipped` would ACCEPT a prompt this size and bill for it.",
        skipped,
        rows,
      },
      null,
      2,
    )}\n`;
    writeFileSync(`${FIXTURE_DIR}model_context_windows.json`, body);
    process.stdout.write(`\nwrote ${FIXTURE_DIR}model_context_windows.json\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`probe failed: ${String(err)}\n`);
  process.exit(1);
});
