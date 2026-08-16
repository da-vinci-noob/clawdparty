import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Which Bedrock models can actually drive an agent loop, measured rather than assumed.
 *
 * The headline finding, and the one no amount of documentation reading produced: **tool use
 * and streaming are two separate capabilities on Bedrock, and for 8 of 18 models they are
 * mutually exclusive.** `ConverseStream` refuses a `toolConfig` for those with
 * "This model doesn't support tool use in streaming mode", while plain `Converse` accepts it —
 * `us.writer.palmyra-x5-v1:0` and `us.mistral.pixtral-large-2502-v1:0` return
 * `stopReason: tool_use` there. Every Llama is in this group.
 *
 * That matters because this harness needs BOTH:  wants live streamed text and the loop
 * is useless without tools. `Capabilities` in `providers/contract.ts` carries `streaming` and
 * `toolUse` as independent booleans, so it can currently claim both — which for these models
 * would be a lie in the only place the picker looks.
 *
 * Regenerate with `npm run probe:converse -- --write` when the catalogue changes. These
 * assertions describe BEDROCK, so a failure means the platform moved, not that our code broke.
 */

const MATRIX = fileURLToPath(new URL("../fixtures/converse/model_matrix.json", import.meta.url));

interface Row {
  profile_id: string;
  vendor: string;
  text: string;
  tool_use_stream: string;
  tool_use_nonstream: string;
  stop_reason: string | null;
  vocabulary: string[];
  reasoning: string | null;
}

const matrix = JSON.parse(readFileSync(MATRIX, "utf8")) as {
  provenance: { region: string; probed_at: string; note: string };
  rows: Row[];
};

const rows = matrix.rows;
const find = (id: string) => rows.find((r) => r.profile_id === id);

describe("the probe covered the catalogue, not a sample", () => {
  it("probed every vendor with a text-capable streaming model", () => {
    const vendors = new Set(rows.map((r) => r.vendor));

    // The point of the sweep: the first captures covered openai and amazon only, and the two
    // agreed with each other — which is exactly the sample that hides a disagreement.
    expect(vendors).toEqual(
      new Set(["meta", "amazon", "openai", "writer", "mistral", "deepseek", "twelvelabs"]),
    );
    expect(rows.length).toBe(18);
  });

  it("records provenance so the matrix can be dated and re-derived", () => {
    expect(matrix.provenance.region).toBe("us-west-2");
    expect(Date.parse(matrix.provenance.probed_at)).not.toBeNaN();
  });

  it("de-duplicates the us./global. pair of the same model", () => {
    const bare = rows.map((r) => r.profile_id.split(".").slice(1).join("."));
    expect(new Set(bare).size).toBe(bare.length);
  });
});

describe("tool use while streaming — the capability that decides usability", () => {
  it("holds for exactly the openai and amazon families", () => {
    const streaming = rows.filter((r) => r.tool_use_stream === "yes").map((r) => r.vendor);

    expect(new Set(streaming)).toEqual(new Set(["openai", "amazon"]));
    expect(streaming).toHaveLength(7);
  });

  it("is refused for every Llama, which CAN call tools without streaming", () => {
    const llamas = rows.filter((r) => r.vendor === "meta");

    expect(llamas.length).toBeGreaterThan(0);
    for (const llama of llamas) {
      expect(llama.tool_use_stream).toBe("no:streaming-only-limit");
      // Not "unsupported" — the non-streaming path accepts the toolConfig. Reading the
      // exception NAME alone (ValidationException) conflated these two answers and produced
      // the wrong conclusion first time round.
      expect(llama.tool_use_nonstream).not.toBe("no:unsupported");
    }
  });

  it("is refused-but-workable for writer and mistral, which DO return tool_use", () => {
    for (const id of ["us.writer.palmyra-x5-v1:0", "us.mistral.pixtral-large-2502-v1:0"]) {
      const row = find(id);
      expect(row?.tool_use_stream).toBe("no:streaming-only-limit");
      expect(row?.tool_use_nonstream).toBe("yes");
    }
  });

  it("distinguishes a CAPABILITY gap from an ENTITLEMENT gap", () => {
    // 's case, with a real example: the profile is listed, the credential is valid, and
    // the account still cannot invoke it. Enumeration must not offer it.
    expect(find("us.amazon.nova-premier-v1:0")?.tool_use_stream).toMatch(/Access denied/);
    // And Converse does not serve every text-output model: pegasus is video understanding.
    expect(find("us.twelvelabs.pegasus-1-2-v1:0")?.text).toMatch(/error/);
  });

  it("finds exactly one model that supports no tools at all", () => {
    const unsupported = rows.filter((r) => r.tool_use_nonstream === "no:unsupported");
    expect(unsupported.map((r) => r.profile_id)).toEqual(["us.deepseek.r1-v1:0"]);
  });
});

describe("reasoning carriers", () => {
  it("finds three incompatible shapes across the catalogue", () => {
    // openai: encrypted bytes; deepseek: plain reasoning text; nova: literal <thinking> in an
    // ordinary text block (captured in converse_fixture, not visible in this plain-text probe).
    expect(find("us.openai.gpt-5.6-sol")?.reasoning).toBe("redacted_bytes");
    expect(find("us.deepseek.r1-v1:0")?.reasoning).toBe("reasoning_text");
  });

  it("shows DeepSeek answering ENTIRELY in reasoning content", () => {
    // A plain question produced no visible text at all. Dropping reasoning content for this
    // model means rendering an empty reply.
    expect(find("us.deepseek.r1-v1:0")?.text).toBe("empty");
  });

  it("does not assume reasoning is uniform within a family", () => {
    // sol reports redacted reasoning; terra and luna did not on the same prompt. A per-family
    // capability flag would be wrong at the model level.
    expect(find("us.openai.gpt-5.6-terra")?.reasoning).toBeNull();
  });
});
