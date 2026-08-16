import { BUILTIN_TOOLS, BUILTIN_TOOL_IDS } from "@clawdparty/contracts";
import { describe, expect, it } from "vitest";
import type { Capabilities } from "../../src/providers/contract.js";
import { buildRegistry } from "../../src/supervisor.js";

/**
 * The tool ids the CLIENT sends are the tool names the HARNESS has. One vocabulary, asserted.
 *
 * They were two, silently, from the moment the Agent SDK came out: `BUILTIN_TOOLS` still listed
 * the SDK's `Read` / `Write` / `Edit` / `Bash`, while the registry registers the provider-native
 * `read` / `str_replace_based_edit_tool` / `bash`. `schemasFor` filters by exact name, so
 * `disallowed_tools` matched nothing and the per-run tool disable did NOTHING — disallowing all
 * eight ids left every registered tool declared. Both suites were green: the web asserted the
 * request body it sent, the harness asserted the filter it applied, and no test compared the
 * vocabularies. This is the guard for that gap.
 *
 * `Write` and `Edit` collapsed into one entry on purpose: there is ONE editor tool
 * (`str_replace_based_edit_tool`) that both creates and edits, so two ids for it could never be
 * honoured separately — disallowing "Write" while allowing "Edit" is not a state the harness can
 * be in, and the picker should not offer it.
 */

const CAPS = {
  toolUse: true,
  serverSideTools: { webSearch: true, webFetch: true, codeExecution: false },
} as unknown as Capabilities;

const registryNames = (): string[] =>
  buildRegistry()
    .schemasFor(CAPS)
    .map((schema) => (schema as { name: string }).name);

describe("BUILTIN_TOOLS vs the registry", () => {
  it("names only tools the harness actually registers", () => {
    const names = registryNames();
    for (const id of BUILTIN_TOOL_IDS) {
      expect(names, `${id} is advertised to clients but no tool answers to it`).toContain(id);
    }
  });

  it("advertises every tool the harness offers, so nothing is undisableable", () => {
    for (const name of registryNames()) {
      expect(BUILTIN_TOOL_IDS, `${name} is offered to models but cannot be disallowed`).toContain(
        name,
      );
    }
  });

  it("actually filters — the property that was silently false", () => {
    const registry = buildRegistry();
    expect(registry.schemasFor(CAPS).length).toBeGreaterThan(0);
    expect(registry.schemasFor(CAPS, BUILTIN_TOOL_IDS)).toEqual([]);
  });

  it("disallows exactly one tool at a time", () => {
    const withoutBash = buildRegistry()
      .schemasFor(CAPS, ["bash"])
      .map((s) => (s as { name: string }).name);

    expect(withoutBash).not.toContain("bash");
    expect(withoutBash).toContain("read");
  });

  it("keeps a human label on every id, since the ids are not readable", () => {
    // `str_replace_based_edit_tool` is a provider-native name, correct and unreadable. The
    // picker renders `label`, never `id`.
    for (const tool of BUILTIN_TOOLS) {
      expect(tool.label).toBeTruthy();
      expect(tool.label).not.toBe(tool.id);
      expect(tool.description).toBeTruthy();
    }
  });
});
