import { describe, expect, it } from "vitest";
import { parseSummary } from "../../scripts/crash_gate_parse.mjs";

/**
 * The crash gate could not read its own input when the terminal had colour on.
 *
 * `crash_gate.mjs` matched `/^\s*Tests\s+(.+)$/m` against vitest's output, and with `FORCE_COLOR`
 * set — ordinary in a developer shell, and this host has `FORCE_COLOR=3` — vitest emits ANSI to a
 * pipe too, so the line actually reads `\x1b[2m      Tests \x1b[22m …`. An escape sequence is not
 * whitespace, so the anchor never matched and the gate exited 1 with "could not find the test
 * summary" while all 50 assertions had just passed.
 *
 * Failing closed is the right direction and it is still a broken gate: it cannot verify S3, and its
 * message points at the tests rather than at the parsing. The gate exists to stop a required step
 * being green for the wrong reason; being red for the wrong reason invites a bypass, which costs the
 * same coverage in the end.
 */

const ESC = "\x1b";
const COLOURED =
  `${ESC}[2m Test Files ${ESC}[22m ${ESC}[1m${ESC}[32m5 passed${ESC}[39m${ESC}[22m${ESC}[90m (5)${ESC}[39m\n` +
  `${ESC}[2m      Tests ${ESC}[22m ${ESC}[1m${ESC}[32m50 passed${ESC}[39m${ESC}[22m${ESC}[90m (50)${ESC}[39m\n`;

const PLAIN = " Test Files  5 passed (5)\n      Tests  50 passed (50)\n";

const WITH_SKIPS = `${ESC}[2m      Tests ${ESC}[22m ${ESC}[32m38 passed${ESC}[39m ${ESC}[33m12 skipped${ESC}[39m (50)\n`;

describe("the gate can read a coloured summary", () => {
  it("finds the counts through ANSI escapes", () => {
    expect(parseSummary(COLOURED)).toEqual({ passed: 50, skipped: 0 });
  });

  it("still reads a plain summary, which is what CI produces", () => {
    expect(parseSummary(PLAIN)).toEqual({ passed: 50, skipped: 0 });
  });

  it("reads a skip count, which is the whole reason the gate parses at all", () => {
    expect(parseSummary(WITH_SKIPS)).toEqual({ passed: 38, skipped: 12 });
  });

  it("returns null when there is genuinely no summary, rather than guessing zero", () => {
    // The distinction the gate's own message insists on: unknown is not the same as zero.
    expect(parseSummary("vitest crashed before reporting anything")).toBeNull();
  });

  it("does not read the Test FILES line as the assertion count", () => {
    // `Test Files  5 passed` also ends in "passed"; matching it would report 5 assertions and
    // silently pass a gate whose 50 assertions never ran.
    expect(parseSummary(COLOURED)?.passed).not.toBe(5);
  });
});
