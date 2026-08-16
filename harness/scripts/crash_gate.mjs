#!/usr/bin/env node
// The crash-injection gate, with a SKIP BUDGET.
//
// `npm run test:crash` is a required CI step, but vitest exits 0 when assertions are
// skipped — so the gate reported green while 12 of its 50 assertions, including the whole
// kill-point sweep, were switched off pending later work. A required gate that can be hollowed
// out silently is the `check-docs` failure mode again: green for the wrong reason.
//
// So the budget is declared HERE, in code, next to the reason. Exceeding it fails the
// gate. Coming in UNDER it also fails — a ratchet, because a budget that only ever goes up
// stops meaning anything, and the moment the skips disappear this file must be the thing that
// notices.

import { spawnSync } from "node:child_process";

/**
 * Assertions currently allowed to be skipped, and why. Lower this the moment a skip is
 * removed; the gate insists on it.
 */
const BUDGET = {
  max: 0,
  reason:
    "nothing — every assertion runs. Raising this above zero needs a " +
    "reason written here and reviewed — the gate exists because a skipped assertion in a " +
    "required step is indistinguishable from a passing one.",
};

const result = spawnSync("npx", ["vitest", "run", "test/crash_injection"], {
  stdio: ["ignore", "pipe", "pipe"],
  encoding: "utf8",
});

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
process.stdout.write(output);

if (result.status !== 0) {
  process.stderr.write("\ncrash gate FAILED — assertions did not pass.\n");
  process.exit(result.status ?? 1);
}

// Vitest prints `Tests  N passed | M skipped (T)`; the skipped clause is absent at zero.
const line = output.match(/^\s*Tests\s+(.+)$/m)?.[1];
if (!line) {
  process.stderr.write(
    "\ncrash gate FAILED — could not find the test summary, so the skip count is unknown.\n" +
      "Unknown is not the same as zero, and the whole point of this gate is not guessing.\n",
  );
  process.exit(1);
}

const skipped = Number(line.match(/(\d+)\s+skipped/)?.[1] ?? 0);
const passed = Number(line.match(/(\d+)\s+passed/)?.[1] ?? 0);

if (passed === 0) {
  // A path that matches no files, or a suite skipped entirely, would otherwise exit 0.
  process.stderr.write("\ncrash gate FAILED — zero assertions ran.\n");
  process.exit(1);
}

if (skipped > BUDGET.max) {
  process.stderr.write(
    `\ncrash gate FAILED — ${skipped} skipped assertions, budget is ${BUDGET.max}.
Raising the budget is a decision, not a fix: say why in BUDGET.reason and get it reviewed, or un-skip the assertion.
`,
  );
  process.exit(1);
}

if (skipped < BUDGET.max) {
  process.stderr.write(
    `\ncrash gate FAILED — only ${skipped} skipped, budget is ${BUDGET.max}.
This is good news and still a failure: lower BUDGET.max to ${skipped} and drop the part of BUDGET.reason that no longer applies. A budget that only ratchets up stops meaning anything.
`,
  );
  process.exit(1);
}

process.stdout.write(
  `\ncrash gate OK — ${passed} passed, ${skipped} skipped (at budget).\n` +
    `Skips are allowed only for: ${BUDGET.reason}\n`,
);
