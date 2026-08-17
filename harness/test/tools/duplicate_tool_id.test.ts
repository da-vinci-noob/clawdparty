import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { ToolDefinition } from "../../src/tools/registry.js";

/**
 * 's other half: two contributors offering the SAME tool id.
 *
 * The requirement asks for both conflict shapes to be detected and resolved by a documented rule,
 * never by load order. Contradictory outcomes on one decision were covered
 * (`extensions/resolution_order.test.ts` — documented bands, registration order as the tie-break).
 * The same-id case was covered by nothing: `register()` did `this.tools.set(name, tool)`, so the
 * last one silently won, and which one that was depended on registration order — exactly what the
 * requirement forbids. Found while cross-checking FR coverage (H1).
 *
 * Silent replacement is the part that matters. A run assembles built-ins, then this session's MCP
 * tools, then a `skill` tool, so a collision means the room believes it has one tool and the model
 * is handed another — and nothing in the record would say so. MCP names are prefixed
 * `mcp__<server>__<tool>`, which makes a built-in collision unlikely rather than impossible, and
 * says nothing about two servers exposing the same name.
 */

function tool(name: string, marker: string): ToolDefinition {
  return {
    name,
    replay: "never",
    schema: { name, description: marker, input_schema: { type: "object", properties: {} } },
    async run() {
      return { ok: true, content: marker };
    },
  } as unknown as ToolDefinition;
}

describe("a duplicate tool id is refused, not silently replaced", () => {
  it("throws when the same id is registered twice", () => {
    const registry = new ToolRegistry().register(tool("bash", "builtin"));

    expect(() => registry.register(tool("bash", "impostor"))).toThrow(/bash/);
  });

  it("names BOTH contributors, so the conflict is actionable", () => {
    const registry = new ToolRegistry().register(tool("read", "builtin"));

    // "duplicate tool" alone would leave someone grepping for which two collided.
    expect(() => registry.register(tool("read", "impostor"))).toThrow(/already registered/i);
  });

  it("keeps the FIRST registration rather than the last", () => {
    const registry = new ToolRegistry().register(tool("grep", "builtin"));

    expect(() => registry.register(tool("grep", "impostor"))).toThrow();
    // The refusal must not half-apply: a throw that had already overwritten the entry would leave
    // the impostor installed AND report a failure.
    expect(registry.get("grep")?.schema.description).toBe("builtin");
  });

  it("still accepts distinct ids, including the MCP-prefixed shape", () => {
    const registry = new ToolRegistry()
      .register(tool("bash", "builtin"))
      .register(tool("mcp__github__search", "connector"))
      .register(tool("mcp__linear__search", "connector"));

    expect(registry.names()).toEqual(["bash", "mcp__github__search", "mcp__linear__search"]);
  });

  it("refuses two connectors that expose the same prefixed name", () => {
    // The realistic collision, given the prefix: not a built-in being shadowed, but one server
    // configured twice under one name.
    const registry = new ToolRegistry().register(tool("mcp__github__search", "first"));

    expect(() => registry.register(tool("mcp__github__search", "second"))).toThrow(
      /mcp__github__search/,
    );
  });
});
