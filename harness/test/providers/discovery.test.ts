import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverAnthropicCredential,
  discoverAwsCredential,
  discoverCodexCredential,
} from "../../src/providers/credentials/discover.js";

/**
 * Credential discovery — the documented precedence, implemented rather than
 * delegated , and the Q6 host paths read DIRECTLY with no mount.
 *
 * Every case here uses an injected fake home, so no test reads the developer's real
 * credentials. That is not just hygiene: a test that read the real `~/.claude` would
 * pass or fail depending on whose machine it ran on.
 */

let home: string;

function fakeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-creds-"));
  mkdirSync(join(dir, ".config", "anthropic"), { recursive: true });
  return dir;
}

/**
 * A credentials file that actually holds a Claude login. The slot is claimed on CONTENTS, not
 * existence — the same file also stores MCP server logins, so `{}` is not a credential.
 * Token material here is obviously fake.
 */
function writeClaudeLogin(): void {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: { accessToken: "sample-not-real", expiresAt: 4_000_000_000_000 },
    }),
  );
}

/** Discovery with a completely empty environment, so nothing leaks in from the host. */
function discover(env: Record<string, string | undefined> = {}, opts = {}) {
  return discoverAnthropicCredential({ env, home, os: "linux", ...opts });
}

beforeEach(() => {
  home = fakeHome();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("precedence — first match wins (R5)", () => {
  it("puts ANTHROPIC_API_KEY ahead of everything", () => {
    writeClaudeLogin();
    const result = discover({ ANTHROPIC_API_KEY: "real", ANTHROPIC_AUTH_TOKEN: "also-real" });

    expect(result).toMatchObject({ source: "env:ANTHROPIC_API_KEY", usable: true });
  });

  it("falls to ANTHROPIC_AUTH_TOKEN when no API key is set", () => {
    expect(discover({ ANTHROPIC_AUTH_TOKEN: "t" })).toMatchObject({
      source: "env:ANTHROPIC_AUTH_TOKEN",
      usable: true,
    });
  });

  it("consults a named profile only after both env vars", () => {
    mkdirSync(join(home, ".config", "anthropic", "credentials"), { recursive: true });
    writeFileSync(join(home, ".config", "anthropic", "credentials", "work"), "{}");

    expect(discover({ ANTHROPIC_PROFILE: "work" })).toMatchObject({
      source: "profile:ANTHROPIC_PROFILE",
      usable: true,
    });
  });

  it("reports a named profile that does not exist as selected-and-invalid", () => {
    const result = discover({ ANTHROPIC_PROFILE: "missing" });

    // Not "no credential": the user asked for a specific profile, so the error must
    // name it rather than reporting a generic absence.
    expect(result.usable).toBe(false);
    expect(result.source).toBe("profile:ANTHROPIC_PROFILE");
    expect(result.problem).toContain("missing");
    expect(result.remedy).toContain("ant auth login");
  });

  it("finds the credentials file the CLI writes", () => {
    writeClaudeLogin();

    expect(discover()).toMatchObject({
      source: "file:~/.claude/.credentials.json",
      usable: true,
    });
  });

  it("reports no credential with an actionable remedy, never a bare failure", () => {
    const result = discover();

    expect(result).toMatchObject({ source: "none", usable: false });
    expect(result.remedy).toMatch(/claude setup-token|ANTHROPIC_API_KEY|ant auth login/);
    // the harness never mints a credential, and the message says so.
    expect(result.remedy).toContain("never mints");
  });
});

describe("the empty-key trap", () => {
  it("reports an EMPTY ANTHROPIC_API_KEY as selected-and-invalid, not absent", () => {
    writeClaudeLogin();

    const result = discover({ ANTHROPIC_API_KEY: "" });

    // THE trap: an empty string still wins its precedence slot and authenticates
    // with nothing. Falling through to the credentials file below would "work" here
    // and then silently pick the wrong login on a machine where it matters.
    expect(result.source).toBe("env:ANTHROPIC_API_KEY");
    expect(result.usable).toBe(false);
    expect(result.problem).toContain("empty");
    // The remedy must say UNSET, not "set it to something" — a blanked value keeps winning.
    expect(result.remedy).toContain("unset");
  });

  it("treats a whitespace-only key the same way", () => {
    expect(discover({ ANTHROPIC_API_KEY: "   " })).toMatchObject({
      source: "env:ANTHROPIC_API_KEY",
      usable: false,
    });
  });

  it("does NOT claim the slot when the variable is genuinely unset", () => {
    writeClaudeLogin();

    expect(discover()).toMatchObject({ source: "file:~/.claude/.credentials.json" });
  });
});

describe("Q6 host paths — read directly, no mount", () => {
  it("reads ~/.claude/.credentials.json from the real filesystem", () => {
    // Under the container topology this file had to arrive through a bind mount.
    // On the host there is no mount in the credential path at all.
    writeClaudeLogin();

    expect(discover().source).toBe("file:~/.claude/.credentials.json");
  });

  it("reaches the macOS Keychain — the case NO mount configuration could serve", () => {
    // A container cannot read the Keychain at any mount configuration, which is why
    // the pre-Q6 docs told developers to run `claude setup-token` by hand. 's
    // "including locations a container cannot reach" is satisfiable because of this.
    const result = discover({}, { os: "darwin", keychainHasToken: () => true });

    expect(result).toMatchObject({ source: "keychain:anthropic-oauth", usable: true });
  });

  it("does not claim the Keychain on a non-darwin host", () => {
    const result = discover({}, { os: "linux", keychainHasToken: () => true });

    expect(result.source).not.toBe("keychain:anthropic-oauth");
  });

  it("prefers an explicit OAuth token env var over the Keychain", () => {
    const result = discover(
      { CLAUDE_CODE_OAUTH_TOKEN: "t" },
      { os: "darwin", keychainHasToken: () => true },
    );

    expect(result.source).toBe("env:CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("reads ~/.codex/auth.json and resolves its mode from auth_mode, not a guess", () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    // The file carries BOTH an API-key slot and an OAuth token object, so which one
    // is live cannot be inferred from which is present.
    writeFileSync(
      join(home, ".codex", "auth.json"),
      JSON.stringify({ auth_mode: "oauth", OPENAI_API_KEY: "stale", tokens: { access: "x" } }),
    );

    expect(discoverCodexCredential({ home })).toMatchObject({
      source: "file:~/.codex/auth.json",
      usable: true,
    });
  });

  it("reports a Codex file with no auth_mode as ambiguous rather than picking one", () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: "k" }));

    const result = discoverCodexCredential({ home });
    expect(result.usable).toBe(false);
    expect(result.problem).toContain("auth_mode");
  });

  it("names AWS_PROFILE or ~/.aws for Bedrock, and warns that SSO expires", () => {
    expect(discoverAwsCredential({ env: { AWS_PROFILE: "work" }, home })).toMatchObject({
      source: "env:AWS_PROFILE",
      usable: true,
    });

    const missing = discoverAwsCredential({ env: {}, home });
    expect(missing.usable).toBe(false);
    // The container could not refresh an SSO token either; the difference is that on
    // the host the developer's own `aws sso login` is the fix, so the message says so.
    expect(missing.remedy).toContain("aws sso login");
    expect(missing.remedy).toContain("cannot refresh");
  });
});

describe("no credential VALUE is ever returned", () => {
  const SECRET = "sk-ant-DISCOVERY-CANARY-000000";

  it("returns only a source identity, for every outcome", () => {
    const results = [
      discover({ ANTHROPIC_API_KEY: SECRET }),
      discover({ ANTHROPIC_AUTH_TOKEN: SECRET }),
      discover({ ANTHROPIC_API_KEY: "" }),
      discover(),
      discoverAwsCredential({ env: { AWS_PROFILE: SECRET }, home }),
    ];

    for (const result of results) {
      // Discovery reports WHERE the credential is, so the run can record the source
      // without the value ever entering the record.
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  });

  it("returns a source drawn from the declared identity set", () => {
    const result = discover({ ANTHROPIC_API_KEY: SECRET });

    expect(result.source).toMatch(/^(env|file|profile|keychain|none)/);
  });
});
