import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONSERVATIVE_CONTEXT_WINDOW,
  inferContextWindow,
} from "../../src/providers/bedrock_routing.js";

/**
 * The context gauge's denominator has to be the model's REAL budget  — and it was a guess.
 *
 * `inferContextWindow` returned 1M for five Anthropic families and a flat 200_000 for everything
 * else. Measured against the live API while verifying S8.4:
 * `us.meta.llama3-1-8b-instruct-v1:0` answered "This model's maximum context length is 131072
 * tokens". So the bar read 65% when that model was actually full, and the run would have died at
 * what looked like two thirds — the exact failure the Converse output-ceiling work already
 * concluded is worth measuring rather than inferring.
 *
 * These assertions read the committed fixture, so the table cannot drift from what Bedrock said.
 */

const FIXTURE = fileURLToPath(
  new URL("../fixtures/converse/model_context_windows.json", import.meta.url),
);

interface Row {
  profile_id: string;
  context_window: number | null;
  message: string;
}
const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { rows: Row[] };
const measured = fixture.rows.filter((r): r is Row & { context_window: number } =>
  Boolean(r.context_window),
);

describe("every measured window is what the code reports", () => {
  it("has measured rows to check at all", () => {
    // A fixture that lost its rows would make every assertion below vacuous.
    expect(measured.length).toBeGreaterThanOrEqual(4);
  });

  for (const row of measured) {
    it(`${row.profile_id} → ${row.context_window}`, () => {
      expect(inferContextWindow(row.profile_id)).toBe(row.context_window);
    });
  }

  it("does not over-declare any of them", () => {
    // The defect, stated as a property: reporting MORE than the real window is what hid the
    // pressure. Reporting less would only show a fuller bar.
    for (const row of measured) {
      expect(inferContextWindow(row.profile_id)).toBeLessThanOrEqual(row.context_window);
    }
  });
});

describe("the unmeasured default", () => {
  it("is conservative, not the old optimistic 200k", () => {
    expect(inferContextWindow("us.some.model-nobody-measured-v1:0")).toBe(
      CONSERVATIVE_CONTEXT_WINDOW,
    );
    expect(CONSERVATIVE_CONTEXT_WINDOW).toBeLessThan(200_000);
  });

  it("applies to the two models that refused WITHOUT naming a number", () => {
    // Their windows are unknown but bounded above by the ~280k that refused them, so the
    // conservative value is the honest answer rather than a guess in the wrong direction.
    for (const id of ["us.deepseek.r1-v1:0", "us.amazon.nova-micro-v1:0"]) {
      expect(inferContextWindow(id)).toBe(CONSERVATIVE_CONTEXT_WINDOW);
    }
  });
});

describe("what the change must NOT move", () => {
  it("keeps the 1M families at 1M", () => {
    for (const id of [
      "us.anthropic.claude-opus-4-8-v1:0",
      "global.anthropic.claude-sonnet-5-v1:0",
      "us.anthropic.claude-fable-5-v1:0",
    ]) {
      expect(inferContextWindow(id)).toBe(1_000_000);
    }
  });

  it("keeps other Anthropic-on-Bedrock models at 200k", () => {
    // The first-party Messages API reports `max_input_tokens` for these, and every Claude model is
    // at least 200k — so the conservative default must not drag them down.
    expect(inferContextWindow("us.anthropic.claude-opus-4-1-20250805-v1:0")).toBe(200_000);
  });
});

describe("the fixture records what the probe cost", () => {
  it("keeps the verbatim message for every row, measured or not", () => {
    for (const row of fixture.rows) {
      expect(row.message).toBeTruthy();
    }
  });

  it("marks the rows that were BILLED rather than quietly dropping them", () => {
    // Five models accepted a ~280k-token input and billed for it, because the filler was sized from
    // documented windows that turned out to be wrong. That is recorded so the next person sizing a
    // filler sees the evidence instead of repeating it.
    const billed = fixture.rows.filter((r) => r.message.startsWith("ACCEPTED"));
    expect(billed.length).toBe(5);
    for (const row of billed) {
      expect(row.context_window).toBeNull();
      expect(inferContextWindow(row.profile_id)).toBe(CONSERVATIVE_CONTEXT_WINDOW);
    }
  });
});
