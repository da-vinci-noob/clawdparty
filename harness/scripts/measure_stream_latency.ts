/**
 * `npm run measure:stream` — 's missing number, measured.
 *
 * The criterion says participants see streaming "within the existing live-latency budget" and names
 * no figure, so nothing can fail it. The figure has to be about what THIS SYSTEM adds, because total
 * first-token latency is dominated by the provider: streaming `claude-opus-5` directly gives ~10
 * `text_delta` events with a ~700ms median gap, and no change here would smooth that.
 *
 * So each sample is a PAIR on the same prompt — once straight at the API, once through the whole
 * stack. That separation is the point: a single-sided measurement would make the criterion a measure
 * of Anthropic's batching rather than of clawdparty.
 *
 * **WHAT FIVE SAMPLES SHOWED, and it invalidated the estimator this script was written to compute.**
 * The paired DIFFERENCE is not usable, because the provider's own first-token latency varies far more
 * than anything this system contributes:
 *
 *   direct first-delta: 1444, 1818, 2692, 2849, 2955 ms   (spread 1511ms)
 *   room   first-delta: 2555, 2585, 2622, 2643, 2826 ms   (spread  271ms)
 *   difference:         +1111, +825, -70, -23, -370 ms    (median -23ms)
 *
 * Three of five differences are NEGATIVE, which does not mean the stack outruns the API it is calling
 * — it means the two calls in a pair saw different provider latencies. Our own figure is the STABLER
 * of the two. So an earlier single-sample reading of "~960ms of overhead" was noise, and a budget
 * stated as a paired difference would fail or pass on Anthropic's variance.
 *
 * The script is kept because the numbers it prints are the evidence for that conclusion, and because
 * the room column IS a stable measurement worth re-checking. What it must not be used for is deriving
 * an overhead bound from a handful of pairs.
 *
 * Spends real tokens on both halves of every pair, so it is a script you invoke, never a suite.
 *
 *   npm run measure:stream -- --samples 5
 */

import { createRequire } from "node:module";
import { readKeychainToken } from "../src/providers/credentials/keychain.js";

// `ws` from the WEB package, deliberately not added to this one. Node's global WebSocket follows the
// WHATWG spec and cannot send a Cookie or Origin header, which the cable handshake requires; adding a
// dependency for a script would repeat the unused-package mistake already cleaned up once.
const require = createRequire(new URL("../../web/package.json", import.meta.url).pathname);
const WebSocket = require("ws");

const BASE = process.env.MEASURE_BASE ?? "http://localhost:3000";
const MODEL = process.env.MEASURE_MODEL ?? "claude-opus-5";
const PROVIDER = process.env.MEASURE_PROVIDER ?? "anthropic-oauth";
const PROMPT = "Write a 200-word explanation of git rebase. Plain prose, no lists, no tools.";
const CLAUDE_CODE = "You are Claude Code, Anthropic's official CLI for Claude.";

const samples = Number(
  process.argv[process.argv.indexOf("--samples") + 1] || process.env.MEASURE_SAMPLES || 3,
);

interface Stream {
  firstDelta: number;
  count: number;
  gaps: number[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]): number =>
  xs.length === 0 ? Number.NaN : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** Straight at the API: the provider's own granularity, with no clawdparty in the path. */
async function direct(token: string): Promise<Stream> {
  const t0 = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      stream: true,
      system: [{ type: "text", text: CLAUDE_CODE }],
      messages: [{ role: "user", content: PROMPT }],
    }),
  });
  if (!res.ok || !res.body) throw new Error(`direct stream ${res.status}: ${await res.text()}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const at: number[] = [];
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const event = JSON.parse(line.slice(6)) as {
        type?: string;
        delta?: { type?: string };
      };
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        at.push(Date.now() - t0);
      }
    }
  }
  return {
    firstDelta: at[0] ?? Number.NaN,
    count: at.length,
    gaps: at.slice(1).map((t, i) => t - at[i]),
  };
}

/** Through the stack: session → run → ActionCable, exactly what a participant gets. */
async function throughRoom(): Promise<Stream> {
  const created = await fetch(`${BASE}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "stream latency", name: "Meter", mode: "chat" }),
  });
  if (!created.ok) throw new Error(`session create ${created.status}`);
  const sessionId = String((await created.json()).session_id);
  const cookie = (created.headers.getSetCookie?.() ?? [])
    .find((c) => c.startsWith("clawd_uid="))
    ?.split(";")[0];
  if (!cookie) throw new Error("no clawd_uid cookie");

  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/~cable`, {
    headers: { Cookie: cookie, Origin: BASE },
  });
  await new Promise<void>((resolve, reject) => {
    ws.on("error", reject);
    ws.on("message", (raw: Buffer) => {
      const m = JSON.parse(raw.toString()) as { type?: string };
      if (m.type === "welcome") {
        ws.send(
          JSON.stringify({
            command: "subscribe",
            identifier: JSON.stringify({ channel: "SessionChannel", session_id: sessionId }),
          }),
        );
      } else if (m.type === "confirm_subscription") resolve();
      else if (m.type === "reject_subscription") reject(new Error("subscription rejected"));
    });
  });

  const at: number[] = [];
  let settled = false;
  ws.on("message", (raw: Buffer) => {
    const m = JSON.parse(raw.toString()) as { type?: string; message?: { type?: string } };
    if (m.type !== undefined || !m.message?.type) return;
    if (m.message.type === "ai_text_delta") at.push(Date.now() - t0);
    if (["run_finished", "run_failed", "run_interrupted"].includes(m.message.type)) settled = true;
  });

  const t0 = Date.now();
  const run = await fetch(`${BASE}/api/sessions/${sessionId}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ prompt: PROMPT, provider: PROVIDER, model: MODEL }),
  });
  if (run.status !== 202) throw new Error(`run ${run.status}: ${await run.text()}`);

  const deadline = Date.now() + 120_000;
  while (!settled && Date.now() < deadline) await sleep(50);
  ws.close();
  if (!settled) throw new Error("run did not settle in 120s");
  return {
    firstDelta: at[0] ?? Number.NaN,
    count: at.length,
    gaps: at.slice(1).map((t, i) => t - at[i]),
  };
}

async function main(): Promise<void> {
  const token = readKeychainToken();
  if (!token) {
    console.error("no host-login token — this measurement needs the first-party streaming path");
    process.exitCode = 1;
    return;
  }
  console.log(`\nstream latency — ${samples} paired sample(s), model ${MODEL}\n`);

  const overheads: number[] = [];
  for (let i = 1; i <= samples; i += 1) {
    const d = await direct(token);
    const r = await throughRoom();
    const overhead = r.firstDelta - d.firstDelta;
    overheads.push(overhead);
    console.log(
      `  ${i}. direct: first ${d.firstDelta}ms, ${d.count} deltas, median gap ${median(d.gaps)}ms\n` +
        `     room:   first ${r.firstDelta}ms, ${r.count} deltas, median gap ${median(r.gaps)}ms\n` +
        `     OUR ADDED first-delta latency: ${overhead}ms`,
    );
    await sleep(1000);
  }

  const worst = Math.max(...overheads);
  console.log(
    `\nadded first-delta latency across ${samples} sample(s): median ${median(overheads)}ms, max ${worst}ms`,
  );
  console.log(
    "The delta COUNT and gap being similar on both sides is the finding that matters: the chunking\n" +
      "is the provider's, so a budget stated as total latency would measure their batching, not ours.",
  );
  if (overheads.some((o) => o < 0)) {
    console.log(
      "\nNEGATIVE differences appeared, which is the signal that this estimator is exhausted: the\n" +
        "provider's first-token variance exceeds anything this system adds. Read the two columns\n" +
        "separately — the room column is the stable one — and do NOT derive an overhead bound here.",
    );
  }
}

main().catch((error) => {
  console.error(`\nmeasurement failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
