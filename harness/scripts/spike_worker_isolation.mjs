#!/usr/bin/env node
/**
 * What does `new Worker(..., { env: {} })` ACTUALLY isolate?
 *
 * The design record assumes a `worker_thread` with an empty `env` is a usable boundary for third-party
 * plugin code. That assumption decides whether third-party plugins can ship at all,
 * so it is measured here rather than trusted: each probe below is something a hostile plugin would
 * try on its first run.
 *
 * Prints a table of what leaked and what did not. Exits 1 if anything the design depends on leaked,
 * so it can gate the feature.
 */
import { Worker } from "node:worker_threads";

// A canary that must never appear inside the worker, and a file path a plugin might try to read.
const CANARY = "sk-ant-SPIKE-CANARY-DO-NOT-SHIP-0000";
process.env.ANTHROPIC_API_KEY = CANARY;
process.env.AWS_SECRET_ACCESS_KEY = `${CANARY}-aws`;

/**
 * Each probe runs INSIDE the worker and reports whether it got at something.
 * `leaked: true` means the boundary did not hold for that attempt.
 */
const PROBE_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");

async function probe(name, fn) {
  try {
    const value = await fn();
    return { name, leaked: value !== null && value !== undefined, detail: describe(value) };
  } catch (err) {
    return { name, leaked: false, detail: \`threw \${err.code ?? err.name}\` };
  }
}

// Never echo a credential VALUE back across the boundary, even in a spike — report its shape.
function describe(value) {
  if (value === null || value === undefined) return "absent";
  const text = String(value);
  if (text.includes("SPIKE-CANARY")) return \`CREDENTIAL-SHAPED (len \${text.length})\`;
  return text.length > 60 ? \`\${text.slice(0, 60)}…\` : text;
}

(async () => {
  const results = [];

  // 1. The env the design relies on being empty.
  results.push(await probe("process.env.ANTHROPIC_API_KEY", () => process.env.ANTHROPIC_API_KEY));
  results.push(await probe("process.env.AWS_SECRET_ACCESS_KEY", () => process.env.AWS_SECRET_ACCESS_KEY));
  // Reported as informational: a COUNT is not a leak, and marking "0" as one made the first
  // artifact misleading.
  results.push({ name: "process.env key count", leaked: false, detail: String(Object.keys(process.env).length) });

  // 2. The filesystem. env:{} says nothing about this — a worker shares the process's FS access.
  results.push(await probe("read ~/.aws/credentials", async () => {
    const { readFileSync } = require("node:fs");
    const { homedir } = require("node:os");
    return readFileSync(require("node:path").join(homedir(), ".aws/credentials"), "utf8").slice(0, 20);
  }));
  results.push(await probe("read ~/.claude.json", async () => {
    const { readFileSync } = require("node:fs");
    const { homedir } = require("node:os");
    return readFileSync(require("node:path").join(homedir(), ".claude.json"), "utf8").slice(0, 20);
  }));

  // 3. Spawning a process — which would make every other boundary moot.
  results.push(await probe("child_process.execSync('echo hi')", () => {
    const { execSync } = require("node:child_process");
    return execSync("echo hi").toString().trim();
  }));
  results.push(await probe("read the PARENT's env via a child process", () => {
    const { execSync } = require("node:child_process");
    const out = execSync("printenv ANTHROPIC_API_KEY || true").toString().trim();
    return out === "" ? null : out;
  }));

  // 4. The network.
  results.push(await probe("fetch is available", () => (typeof fetch === "function" ? "yes" : null)));

  // 5. Requiring the harness's own credential module.
  // An ABSOLUTE path, handed in by the parent. The first version used a relative one from eval'd
  // source and MODULE_NOT_FOUND was a path artifact, not a boundary — reporting that as isolation
  // would have been the worst kind of wrong answer here.
  results.push(await probe("read the credential module's SOURCE from disk", () => {
    const { readFileSync } = require("node:fs");
    return readFileSync(workerData.credentialModule, "utf8").slice(0, 24);
  }));
  results.push(await probe("spawn a process that prints an AWS credential", () => {
    const { execSync } = require("node:child_process");
    const out = execSync("aws configure export-credentials 2>/dev/null || true").toString().trim();
    return out === "" ? null : "AWS CLI RETURNED CREDENTIALS";
  }));

  // 6. Shared memory with the parent.
  results.push(await probe("SharedArrayBuffer", () => (typeof SharedArrayBuffer === "function" ? "yes" : null)));

  parentPort.postMessage(results);
})();
`;

function runWorker(options, label) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(PROBE_SOURCE, { eval: true, ...options });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`${label}: worker did not report within 10s`));
    }, 10_000);
    worker.once("message", (results) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(results);
    });
    worker.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Probes whose leaking would invalidate the DESIGN as written. The others are informative: a
 * boundary that shares the filesystem is still a boundary, as long as the design says so.
 */
const DESIGN_CRITICAL = new Set([
  "process.env.ANTHROPIC_API_KEY",
  "process.env.AWS_SECRET_ACCESS_KEY",
  "require the credential discovery module",
]);

const results = await runWorker(
  {
    env: {},
    workerData: {
      credentialModule: new URL("../src/providers/credentials/discover.ts", import.meta.url)
        .pathname,
    },
  },
  "env:{}",
);

console.log("\n  worker_threads with env: {} \n");
console.log(`  ${"probe".padEnd(46)} ${"leaked".padEnd(8)} detail`);
console.log(`  ${"-".repeat(46)} ${"-".repeat(8)} ${"-".repeat(30)}`);
let criticalLeaks = 0;
for (const { name, leaked, detail } of results) {
  const mark = leaked ? "YES" : "no";
  const critical = leaked && DESIGN_CRITICAL.has(name);
  if (critical) criticalLeaks += 1;
  console.log(`  ${name.padEnd(46)} ${(critical ? `${mark} ‼` : mark).padEnd(8)} ${detail}`);
}

console.log(
  `\n  ${criticalLeaks === 0 ? "env isolation HOLDS" : `${criticalLeaks} DESIGN-CRITICAL LEAK(S)`} — anything above marked YES without ‼ is a capability the design must ACCOUNT for,
  not necessarily a defect.\n`,
);

process.exit(criticalLeaks === 0 ? 0 : 1);
