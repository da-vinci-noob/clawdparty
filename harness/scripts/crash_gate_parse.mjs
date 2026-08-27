// Reading vitest's summary, separated from the gate so it can be tested.
//
// It lived inline in `crash_gate.mjs` and was wrong: `/^\s*Tests\s+(.+)$/m` cannot match when
// colour is on, because the line begins with an escape sequence rather than whitespace. The gate
// then exited 1 saying it could not find the summary, with 50 assertions passing.

/** biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI means matching ESC. */
const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * `{ passed, skipped }` from vitest's `Tests` line, or null when there is no such line.
 *
 * Null and not `{ passed: 0 }` — the gate's own rule is that unknown is not the same as zero, and
 * collapsing them is how a run that crashed before reporting would read as a run with no skips.
 */
export function parseSummary(output) {
  // Anchored on `Tests` with the word boundary before it, so the `Test Files` line cannot match:
  // it also ends in "passed", and reading it would report 5 assertions for a 50-assertion suite.
  const line = output.replace(ANSI, "").match(/^\s*Tests\s+(.+)$/m)?.[1];
  if (!line) return null;

  return {
    passed: Number(line.match(/(\d+)\s+passed/)?.[1] ?? 0),
    skipped: Number(line.match(/(\d+)\s+skipped/)?.[1] ?? 0),
  };
}
