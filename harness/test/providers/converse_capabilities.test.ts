import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  TABLE_MEASURED_AT,
  converseCapabilities,
  isInvocable,
  toolUseWhileStreaming,
} from "../../src/providers/converse_capabilities.js";
import { assertTotalCapabilities } from "../adapters/conformance.js";

/**
 * The audit check: the 8 streaming-limited models are HANDLED by the rule, not assumed away.
 *
 * The table in `converse_capabilities.ts` exists because Bedrock answers no question about tool
 * use, let alone about tool use combined with streaming. A hand-maintained table is exactly the
 * artifact that rots, and this repo already has a precedent: a capability table whose passing
 * test defended the wrong column. So every row of the COMMITTED PROBE is cross-checked against
 * the table here: a re-probe that disagrees fails the build instead of drifting.
 */

const MATRIX = fileURLToPath(new URL("../fixtures/converse/model_matrix.json", import.meta.url));

interface Row {
  profile_id: string;
  tool_use_stream: string;
  tool_use_nonstream: string;
  text: string;
}

const rows = (JSON.parse(readFileSync(MATRIX, "utf8")) as { rows: Row[] }).rows;

describe("the table agrees with the probe, row by row", () => {
  it("has rows to check, so this is not vacuously true", () => {
    expect(rows.length).toBe(18);
  });

  for (const row of rows) {
    it(`${row.profile_id}`, () => {
      const measuredStreamsTools = row.tool_use_stream === "yes";
      expect(
        toolUseWhileStreaming(row.profile_id),
        `table says ${toolUseWhileStreaming(row.profile_id)}, probe measured ${row.tool_use_stream}`,
      ).toBe(measuredStreamsTools);
    });
  }

  it("counts exactly 7 models that stream tools", () => {
    const streaming = rows.filter((r) => toolUseWhileStreaming(r.profile_id));
    expect(streaming).toHaveLength(7);
  });

  it("counts exactly 8 that are offerable but cannot stream tools", () => {
    const limited = rows.filter(
      (r) => isInvocable(r.profile_id) && !toolUseWhileStreaming(r.profile_id),
    );
    // Every Llama, mistral pixtral, both writer palmyra. These are the models the rule exists for:
    // offered, usable, and declared honestly as unable to do both at once.
    expect(limited).toHaveLength(8);
  });
});

describe("models that cannot be served at all", () => {
  it("excludes the one with no tool support in either transport", () => {
    // An agent loop cannot read or edit a file without tools, so offering it would be offering
    // a model that fails the first thing anyone asks of it.
    expect(isInvocable("us.deepseek.r1-v1:0")).toBe(false);
  });

  it("excludes an entitlement gap and a model Converse does not serve", () => {
    // Both were listed by ListInferenceProfiles with a valid credential. : a model the
    // host cannot serve must not reach the picker.
    expect(isInvocable("us.amazon.nova-premier-v1:0")).toBe(false);
    expect(isInvocable("us.twelvelabs.pegasus-1-2-v1:0")).toBe(false);
  });

  it("keeps every model the probe found invocable", () => {
    const usable = rows.filter((r) => r.text === "ok" && r.tool_use_nonstream === "yes");
    for (const row of usable) {
      expect(isInvocable(row.profile_id), `${row.profile_id} should be offerable`).toBe(true);
    }
  });
});

describe("an unmeasured model", () => {
  it("defaults to NOT streaming tools", () => {
    // The safe direction: a wrong `false` refuses the run with a message naming the constraint,
    // while a wrong `true` sends a request Bedrock rejects with an opaque ValidationException.
    expect(toolUseWhileStreaming("us.somevendor.model-released-tomorrow-v1:0")).toBe(false);
  });

  it("is still considered invocable, since nothing measured says otherwise", () => {
    expect(isInvocable("us.somevendor.model-released-tomorrow-v1:0")).toBe(true);
  });
});

describe("the capability object", () => {
  it("satisfies the same totality rule every adapter must", () => {
    assertTotalCapabilities(
      converseCapabilities("us.openai.gpt-5.6-sol", 400_000, 64_000),
      "bedrock-converse/gpt-5.6-sol",
    );
  });

  it("declares promptCaching false, because no captured usage reported a cache field", () => {
    const caps = converseCapabilities("us.openai.gpt-5.6-sol", 400_000, 64_000);

    // Claiming it would place cache breakpoints that are never honoured, and silently re-pay
    // full input cost every turn while the table said otherwise.
    expect(caps.promptCaching).toBe(false);
    expect(caps.minCacheablePrefixTokens).toBeNull();
  });

  it("carries the measured tool/stream answer per model", () => {
    expect(
      converseCapabilities("us.openai.gpt-5.6-sol", 400_000, 64_000).toolUseWhileStreaming,
    ).toBe(true);
    expect(
      converseCapabilities("us.meta.llama3-3-70b-instruct-v1:0", 128_000, 8_192)
        .toolUseWhileStreaming,
    ).toBe(false);
  });

  it("is dated, so a stale table is visible rather than assumed current", () => {
    expect(TABLE_MEASURED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
