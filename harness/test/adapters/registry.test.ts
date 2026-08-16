import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADAPTER_IDS, adapterById, buildAdapters, isAdapterId } from "../../src/providers/index.js";

/**
 * the loop resolves a provider by id and NEVER special-cases one.
 *
 * The registry is what makes adding a provider a registration rather than a branch. That
 * claim is only true while nothing outside `providers/` knows an adapter id, so the second
 * describe block asserts it at the source — the same genre as `no_shell_input.test.ts` and
 * `rule_isolation.test.ts`. A behavioural test proves the adapters that exist today work; a
 * source assertion proves no coupling was ADDED, which is the change worth catching.
 */

const SRC = new URL("../../src/", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    try {
      return sourceFiles(path);
    } catch {
      return path.endsWith(".ts") ? [path] : [];
    }
  });
}

const read = (path: string) => readFileSync(path, "utf8");

describe("the registry resolves by id", () => {
  it("registers every declared id, and nothing it does not declare", () => {
    const built = buildAdapters().map((a) => a.id);

    // Two lists that must agree: `ADAPTER_IDS` is what callers validate against, and
    // `buildAdapters()` is what actually gets constructed. A drift means a provider a client
    // is told exists cannot be resolved.
    expect(built).toEqual([...ADAPTER_IDS]);
  });

  it("returns the adapter for a known id", () => {
    for (const id of ADAPTER_IDS) {
      expect(adapterById(id)?.id, `${id} did not resolve`).toBe(id);
    }
  });

  it("returns null for an unknown id rather than a default", () => {
    // A default would run someone's prompt against a provider they did not choose and bill
    // an account they did not pick. Null forces the caller to say so.
    expect(adapterById("openai-gpt-9")).toBeNull();
    expect(adapterById("")).toBeNull();
  });

  it("guards ids with a type predicate, so a string cannot become an id by accident", () => {
    expect(isAdapterId("anthropic-bedrock")).toBe(true);
    expect(isAdapterId("anthropic-bedrock-v2")).toBe(false);
  });

  it("hands out FRESH instances, because each caches its own model capabilities", async () => {
    const first = adapterById("anthropic-direct");
    const second = adapterById("anthropic-direct");

    // A shared instance would serve one session's cached model list to another, and the
    // cache is keyed only by model id — not by which credential filled it.
    expect(first).not.toBe(second);
  });

  it("gives every adapter a distinct id and a human-facing name", () => {
    const adapters = buildAdapters();

    expect(new Set(adapters.map((a) => a.id)).size).toBe(adapters.length);
    for (const adapter of adapters) {
      // The picker shows this. An id like `anthropic-oauth` in a dropdown is a leak of
      // internal naming into a participant's face.
      expect(adapter.displayName, `${adapter.id} has no displayName`).toBeTruthy();
      expect(adapter.displayName).not.toBe(adapter.id);
    }
  });

  it("declares an entitlement posture on every adapter", () => {
    for (const adapter of buildAdapters()) {
      // recorded per adapter, never assumed. A missing posture would leave the run
      // unable to say whose account it spent.
      expect(adapter.entitlement.credentialKind, `${adapter.id}`).toBeTruthy();
      expect(["yes", "no", "owner_decision_required"]).toContain(
        adapter.entitlement.thirdPartyClientPermitted,
      );
      expect(adapter.entitlement.note.length, `${adapter.id} has an empty note`).toBeGreaterThan(0);
    }
  });
});

describe("no adapter id appears outside providers/", () => {
  const outside = sourceFiles(SRC).filter(
    (path) => !path.slice(SRC.length).startsWith("providers/"),
  );

  it("has files to check, so this is not vacuously true", () => {
    expect(outside.length).toBeGreaterThan(0);
  });

  it("never names anthropic-oauth or anthropic-bedrock", () => {
    // These two are the test: `anthropic-direct` is also the documented DEFAULT provider, so
    // it legitimately appears in `supervisor.ts` as a fallback string. The other two have no
    // such excuse — either name outside `providers/` means something branched on a provider.
    const offenders = outside.filter((path) =>
      /"anthropic-oauth"|"anthropic-bedrock"/.test(read(path)),
    );

    expect(offenders.map((p) => p.slice(SRC.length))).toEqual([]);
  });

  it("keeps the loop free of every adapter id, including the default", () => {
    const loopFiles = sourceFiles(join(SRC, "loop"));
    const offenders = loopFiles.filter((path) => /anthropic-|"codex"/.test(read(path)));

    // The loop is the file set  is actually about: it reads `capabilities()` and knows
    // nothing else. One id here and providers have stopped being interchangeable.
    expect(offenders.map((p) => p.slice(SRC.length))).toEqual([]);
  });

  it("imports no vendor SDK outside providers/", () => {
    // Import form only, for the same reason as above: a comment naming the rule is not a
    // breach of it.
    const vendors = /from "@anthropic-ai\/sdk"|from "@anthropic-ai\/bedrock-sdk"|from "openai"/;
    const offenders = outside.filter((path) => vendors.test(read(path)));

    // The binding rule. A vendor type reaching `loop/` means the seam is decorative.
    expect(offenders.map((p) => p.slice(SRC.length))).toEqual([]);
  });

  it("confines the MCP SDK to ONE file, the way the provider SDKs are confined", () => {
    // Same rule, different vendor. One importer means one place a server is spawned, one
    // place a transport is chosen, and one place to look when a server misbehaves — and it keeps
    // MCP types out of `tools/` and `loop/`, which must not know that a tool came from a
    // subprocess. Matched as an IMPORT so a comment naming the rule is not a breach of it.
    const importers = sourceFiles(SRC)
      .filter((path) => /from "@modelcontextprotocol\/sdk|import\(\s*"@modelcontextprotocol\/sdk/.test(read(path)))
      .map((path) => path.slice(SRC.length))
      .sort();

    expect(importers).toEqual(["mcp/client.ts"]);
  });

  it("confines each vendor SDK to ONE adapter file", () => {
    const providerFiles = sourceFiles(join(SRC, "providers"));
    const importers = (pattern: RegExp) =>
      providerFiles
        .filter((p) => pattern.test(read(p)))
        .map((p) => p.slice(SRC.length))
        .sort();

    // Matched as an IMPORT, not as a bare package name. The first version searched for
    // `@anthropic-ai/bedrock-sdk` anywhere and flagged `contract.ts`, whose comment
    // DOCUMENTS the binding rule — a guard that reports its own documentation as a
    // violation gets weakened or deleted, so the signal has to be exact.
    //
    // The bedrock SDK is the sharp case: two files importing it would mean two clients with
    // two different credential resolutions, and the run would record one while using the
    // other.
    expect(importers(/from "@anthropic-ai\/bedrock-sdk"/)).toEqual([
      "providers/anthropic_bedrock.ts",
    ]);
    // `@anthropic-ai/sdk` is shared by the two first-party paths, which are genuinely the
    // same API reached with different credentials.
    expect(importers(/from "@anthropic-ai\/sdk"/)).toEqual([
      "providers/anthropic_direct.ts",
      "providers/anthropic_oauth.ts",
    ]);

    // The Bedrock RUNTIME client (Converse) is bedrock-converse's vendor SDK. A second file
    // constructing it would be a second client with its own credential resolution — the same
    // record-vs-reality hazard as the bedrock SDK above. VALUE imports only: `converse_stream`
    // and `converse_request` take TYPES from it (erased at runtime), which is not a client.
    const valueImporters = providerFiles
      .filter((p) =>
        /(?<!type )\{[^}]*\} from "@aws-sdk\/client-bedrock-runtime"|import\(\s*"@aws-sdk\/client-bedrock-runtime"/.test(
          read(p),
        ),
      )
      .map((p) => p.slice(SRC.length))
      .sort();
    expect(valueImporters).toEqual(["providers/bedrock_converse.ts"]);
  });

  it("keeps the shared family mapper vendor-free", () => {
    const body = read(join(SRC, "providers/anthropic_family.ts"));

    // It is shared BY the adapters, so a vendor import here would put a vendor type in code
    // three adapters depend on — the one place the binding rule is easiest to lose.
    expect(body).not.toMatch(/from "@anthropic-ai/);
    expect(body).not.toMatch(/from "openai"/);
  });
});
