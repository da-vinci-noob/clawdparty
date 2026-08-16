import { describe, expect, it } from "vitest";
import { commitBoundaries, recover, runToCrash } from "./harness.js";

/**
 * zero `tool_use` entries lack a matching `tool_result`.
 *
 * Not cosmetic bookkeeping. A provider REJECTS a request whose assistant turn contains a
 * tool_use with no corresponding tool_result, so an unsettled call does not degrade the
 * conversation — it makes the next request impossible, and the session is stuck for good.
 * That is the precise shape of "stranded" this feature removes.
 */

const boundaries = commitBoundaries();

/** tool_use ids on the surface, and the tool_result ids answering them. */
function pairs(entries: Awaited<ReturnType<typeof recover>>["entries"]) {
  const uses = new Set<string>();
  const results = new Set<string>();
  for (const entry of entries) {
    for (const block of (entry.blocks ?? []) as Array<Record<string, unknown>>) {
      if (block.type === "tool_use") uses.add(String(block.id));
      if (block.type === "tool_result") results.add(String(block.tool_use_id));
    }
  }
  return { uses, results };
}

describe("every tool_use has a tool_result", () => {
  it.each(boundaries)("kill at commit %i, then recover: no unanswered call", async (at) => {
    const state = await recover(runToCrash(at));
    const { uses, results } = pairs(state.entries);

    const unanswered = [...uses].filter((id) => !results.has(id));
    expect(unanswered, `unanswered tool_use after a kill at commit ${at}`).toEqual([]);
  });

  it("answers a `never` call with an explicit interrupted result, not silence", async () => {
    // Finds the boundary where recovery actually SYNTHESIZED rather than hardcoding a
    // commit index. The loop settles each result as it completes, so a call
    // that finished before the crash is answered by its REAL result — the interrupted
    // text only appears where a call was caught mid-effect, and which commit that is
    // moves whenever the narrative changes.
    // Must be a boundary that synthesized AND already has tool_use blocks. The earliest
    // synthesizing boundary is the request-window uncertainty, which happens before any
    // tool_use exists — a `.find(synthesized > 0)` picks that one and tests nothing about
    // tool calls.
    const states = await Promise.all(boundaries.map(async (at) => recover(runToCrash(at))));
    const synthesized = states.find((s) => s.synthesized > 0 && pairs(s.entries).uses.size > 0);
    if (!synthesized) throw new Error("no boundary caught a `never` TOOL CALL mid-effect");

    const { uses, results } = pairs(synthesized.entries);
    // Silence and an interrupted result are both "not re-run", but only one of them
    // leaves a conversation the model can continue.
    expect(uses.size).toBeGreaterThan(0);
    expect([...uses].every((id) => results.has(id))).toBe(true);
    expect(JSON.stringify(synthesized.entries)).toContain("interrupted");
  });

  it("finds tool_use blocks at all, so the sweep is not vacuously true", async () => {
    // A run whose surface held no tool_use would satisfy every assertion above while
    // testing nothing.
    const state = await recover(runToCrash(boundaries.at(-1) as number));
    expect(pairs(state.entries).uses.size).toBeGreaterThan(0);
  });
});
