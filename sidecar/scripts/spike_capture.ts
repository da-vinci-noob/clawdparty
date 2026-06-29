// SDK message spike harness (sdk-message-spike / sdk-spike-capture).
//
// Runs a REAL @anthropic-ai/claude-agent-sdk query() against a throwaway repo and
// dumps EVERY raw SDK message verbatim, in yield order, to OUT_PATH — the raw
// fixture that the normalizer mapping + tests are derived from.
//
// It owns NO credential and selects NO auth method: the SDK auto-detects from the
// inherited host environment (here, Bedrock via the mounted ~/.aws + the passed-
// through CLAUDE_CODE_USE_BEDROCK / AWS_PROFILE / AWS_REGION / ANTHROPIC_MODEL).
//
// Honors the spec's "block rather than fabricate" rule: if auth is unusable or the
// run cannot complete, it writes NO partial fixture and exits non-zero.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const OUT_PATH = process.env.SPIKE_OUT_PATH ?? "/app/test/fixtures/raw_run.jsonl";
const REPO = process.env.SPIKE_REPO_PATH ?? "/repo";

// A prompt that exercises the message types the mapping needs: assistant text,
// thinking, a file-editing tool call, a Bash command, and run completion. The
// repo is a throwaway scratch dir with no credential in scope.
const PROMPT = [
  "Do exactly these steps in the current directory, then stop:",
  "1. Briefly think about what you're about to do.",
  "2. Create a file named SPIKE_NOTE.md containing a single line: 'hello from the spike'.",
  "3. Run the shell command: cat SPIKE_NOTE.md",
  "4. Tell me you're done in one sentence.",
].join("\n");

async function main(): Promise<void> {
  const captured: unknown[] = [];

  const stream = query({
    prompt: PROMPT,
    options: {
      cwd: REPO,
      permissionMode: "acceptEdits",
      allowedTools: ["Read", "Write", "Edit", "Bash"],
      maxTurns: 12,
      // Load NO host settings, so the capture does not enumerate the host
      // developer's private skills/slash-commands/agents into the fixture. The
      // mapping needs only the message shapes, never the host catalog. Auth
      // (Bedrock via ~/.aws + env) is independent of settingSources.
      settingSources: [],
      ...(process.env.ANTHROPIC_MODEL ? { model: process.env.ANTHROPIC_MODEL } : {}),
    },
  });

  for await (const message of stream) {
    // Verbatim, in yield order. No transform, no redact, no reorder.
    captured.push(message);
    // Mirror to stderr so progress is visible without polluting the fixture.
    process.stderr.write(`[spike] ${(message as { type?: string }).type ?? "?"}\n`);
  }

  if (captured.length === 0) {
    throw new Error("no SDK messages captured — refusing to write a partial/empty fixture");
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${captured.map((m) => JSON.stringify(m)).join("\n")}\n`, "utf8");
  process.stderr.write(`[spike] wrote ${captured.length} raw messages to ${OUT_PATH}\n`);
}

main().catch((err) => {
  // Block rather than fabricate: do NOT write a partial fixture on failure.
  process.stderr.write(`[spike] FAILED (no fixture written): ${String(err)}\n`);
  process.exit(1);
});
