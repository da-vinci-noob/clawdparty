import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAnthropicCredential } from "../../src/providers/credentials/discover.js";
import {
  KEYCHAIN_QUERY,
  SECURITY_BIN,
  keychainHasToken,
} from "../../src/providers/credentials/keychain.js";
import { KEYCHAIN_SOURCE } from "../../src/providers/credentials/sources.js";

/**
 * The macOS Keychain slot, which was unreachable in production for two separate reasons.
 *
 * names the Keychain as a place only a host process can reach, and it is the one credential
 * location a subscription/enterprise user on macOS actually has. The slot existed in
 * `discoverAnthropicCredential` with its probe INJECTED and defaulting to `false`, so
 * `anthropic-oauth` reported itself unavailable on exactly the hosts where the credential was
 * present — and the service name it would have queried was wrong anyway.
 *
 * Both were measured on a host that has the credential:
 *
 *   security find-generic-password -s "Claude Code"              → not found
 *   security find-generic-password -s "Claude Code-credentials"   → found
 */

const originalPlatform = process.platform;

function pretendPlatform(value: string): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
});

describe("the query it runs", () => {
  it("asks about the service name that actually exists", () => {
    // The measured name. `"Claude Code"` finds nothing, so a probe keyed on it returns false
    // forever — which is indistinguishable from having no credential.
    expect(KEYCHAIN_SOURCE.service).toBe("Claude Code-credentials");
    expect(KEYCHAIN_QUERY).toEqual(["find-generic-password", "-s", "Claude Code-credentials"]);
  });

  it("NEVER passes -w, the flag that prints the password", () => {
    // The whole safety argument in one assertion: existence is all discovery needs, so the secret
    // has no reason to enter this process at all.
    expect(KEYCHAIN_QUERY).not.toContain("-w");
    expect(KEYCHAIN_QUERY.join(" ")).not.toMatch(/-w\b/);
  });

  it("runs the absolute binary path, not a name resolved through PATH", () => {
    // A bare `security` would resolve through PATH, which a user's shell configuration can
    // rearrange — and this is a credential query.
    expect(SECURITY_BIN).toBe("/usr/bin/security");
  });

  it("builds an argv with nothing interpolated into it", () => {
    // Every element is a literal or a module constant. Asserted against the SOURCE because the
    // property is about what the code can be made to do, not about one call's arguments.
    const source = readFileSync(
      new URL("../../src/providers/credentials/keychain.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/execFileSync\(\s*`/);
    expect(source).not.toMatch(/\$\{/);
    expect(source).not.toMatch(/shell:\s*true/);
  });
});

describe("what it reports", () => {
  // These inject a runner to test the REPORTING logic, which is platform-independent. Force darwin
  // so the real-reader platform guard does not short-circuit them to false on CI's Linux (the
  // top-level afterEach restores). The dedicated "platform gating" block below owns the OS behaviour.
  beforeEach(() => pretendPlatform("darwin"));

  it("true when `security` exits 0 — the item is there", () => {
    expect(keychainHasToken(() => 0)).toBe(true);
  });

  it("false on exit 44, which is `security`'s item-not-found", () => {
    expect(keychainHasToken(() => 44)).toBe(false);
  });

  it("false when the binary is missing or the keychain is locked", () => {
    // Reported as "this slot cannot serve" rather than as an error: discovery walks a precedence
    // list, and one slot failing must let the next be tried.
    expect(keychainHasToken(() => 1)).toBe(false);
  });

  it("does not throw when the runner itself throws", () => {
    expect(() =>
      keychainHasToken(() => {
        throw new Error("spawn EACCES");
      }),
    ).not.toThrow();
  });

  it("passes the fixed argv to the runner, unchanged", () => {
    const seen: Array<{ bin: string; args: readonly string[] }> = [];
    keychainHasToken((bin, args) => {
      seen.push({ bin, args });
      return 0;
    });

    expect(seen).toEqual([{ bin: SECURITY_BIN, args: KEYCHAIN_QUERY }]);
  });
});

describe("platform gating", () => {
  it("does not run anything off darwin", () => {
    pretendPlatform("linux");
    let ran = false;

    const result = keychainHasToken(() => {
      ran = true;
      return 0;
    });

    // There is no Keychain to ask, and spawning `/usr/bin/security` on Linux would be a stray
    // process launch on every discovery walk.
    expect(result).toBe(false);
    expect(ran).toBe(false);
  });

  it("runs on darwin", () => {
    pretendPlatform("darwin");
    expect(keychainHasToken(() => 0)).toBe(true);
  });
});

describe("discovery uses it", () => {
  // Keys are OMITTED, not set empty: an empty `ANTHROPIC_API_KEY` claims slot 1 as unusable — the
  // documented empty-key trap — so an empty-string fixture never reaches the keychain slot at all.
  const noEnv: Record<string, string | undefined> = {};
  let emptyHome: string;

  beforeEach(() => {
    // A home with no credential files, because the file/profile slots sit ABOVE the keychain and
    // read the real filesystem. Pointing at the developer's actual home made the outcome depend on
    // whose machine the suite ran on.
    emptyHome = mkdtempSync(join(tmpdir(), "harness-keychain-home-"));
  });
  afterEach(() => rmSync(emptyHome, { recursive: true, force: true }));

  const discover = (over: Partial<Parameters<typeof discoverAnthropicCredential>[0]> = {}) =>
    discoverAnthropicCredential({ env: noEnv, home: emptyHome, os: "darwin", ...over });

  it("reports the keychain slot when the probe says yes", () => {
    expect(discover({ keychainHasToken: () => true })).toMatchObject({
      source: KEYCHAIN_SOURCE.id,
      usable: true,
    });
  });

  it("reports NO credential when the probe says no", () => {
    expect(discover({ keychainHasToken: () => false }).usable).toBe(false);
  });

  it("still prefers an explicit env token over the keychain", () => {
    // The env var was the documented workaround for this gap and stays supported; it must keep
    // winning, or a developer who set it deliberately would be overridden by a stale Keychain item.
    const result = discover({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-EXAMPLE-NOT-REAL" },
      keychainHasToken: () => true,
    });

    expect(result.source).toBe("env:CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("does not consult the keychain at all off darwin", () => {
    let asked = false;
    discover({
      os: "linux",
      keychainHasToken: () => {
        asked = true;
        return true;
      },
    });

    expect(asked).toBe(false);
  });
});
