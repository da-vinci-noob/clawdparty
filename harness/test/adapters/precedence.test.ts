import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREDENTIAL_PRECEDENCE } from "@clawdparty/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverAnthropicCredential,
  discoverAwsCredential,
} from "../../src/providers/credentials/discover.js";

/**
 * the documented credential order is APPLIED, the winner is REPORTED, and the
 * empty-key trap does not fall through.
 *
 * The trap, verbatim from the vendor reference: "profiles are only consulted when no API key
 * is set. A stale exported ANTHROPIC_API_KEY silently overrides every profile." An
 * `ANTHROPIC_API_KEY=""` still CLAIMS its slot and then authenticates with nothing, so the
 * only safe report is selected-and-invalid. Falling through to the next slot would be the
 * silent wrong pick this whole module exists to prevent — the run would work, against a
 * different account than the developer believes.
 *
 * Discovery is pure over injected env/home, so every slot is reachable in a test without a
 * real credential anywhere.
 */

let home: string;

function env(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return over;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "harness-precedence-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function writeProfile(name: string): void {
  const dir = join(home, ".config", "anthropic", "credentials");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), "{}");
}

function writeCredentialsFile(): void {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
}

describe("the documented order is applied, first match wins", () => {
  it("prefers ANTHROPIC_API_KEY over everything below it", () => {
    writeProfile("work");
    writeCredentialsFile();

    const found = discoverAnthropicCredential({
      env: env({ ANTHROPIC_API_KEY: "sk-ant-not-a-real-key", ANTHROPIC_PROFILE: "work" }),
      home,
    });

    expect(found).toMatchObject({ source: "env:ANTHROPIC_API_KEY", usable: true });
  });

  it("prefers ANTHROPIC_AUTH_TOKEN over profiles, but not over the key", () => {
    writeProfile("work");

    const withBoth = discoverAnthropicCredential({
      env: env({ ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t" }),
      home,
    });
    const tokenOnly = discoverAnthropicCredential({
      env: env({ ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_PROFILE: "work" }),
      home,
    });

    expect(withBoth.source).toBe("env:ANTHROPIC_API_KEY");
    expect(tokenOnly.source).toBe("env:ANTHROPIC_AUTH_TOKEN");
  });

  it("uses the ANTHROPIC_PROFILE-named profile when no env credential is set", () => {
    writeProfile("work");

    const found = discoverAnthropicCredential({ env: env({ ANTHROPIC_PROFILE: "work" }), home });

    expect(found).toMatchObject({ source: "profile:ANTHROPIC_PROFILE", usable: true });
  });

  it("falls to the active profile, then WIF, then the credentials file", () => {
    // Each rung in isolation, so a slot that stopped being reachable shows up here rather
    // than as "my other login stopped working".
    mkdirSync(join(home, ".config", "anthropic", "credentials"), { recursive: true });
    expect(discoverAnthropicCredential({ env: env(), home }).source).toBe("profile:active");

    const bare = mkdtempSync(join(tmpdir(), "harness-bare-"));
    expect(
      discoverAnthropicCredential({ env: env({ ANTHROPIC_WIF_TOKEN_FILE: "/t" }), home: bare })
        .source,
    ).toBe("env:workload-identity-federation");

    mkdirSync(join(bare, ".claude"), { recursive: true });
    writeFileSync(join(bare, ".claude", ".credentials.json"), "{}");
    expect(discoverAnthropicCredential({ env: env(), home: bare }).source).toBe(
      "file:~/.claude/.credentials.json",
    );
    rmSync(bare, { recursive: true, force: true });
  });

  it("reports NO credential with a remedy rather than an empty answer", () => {
    // `keychainHasToken: () => false` is REQUIRED, not decorative. The Keychain probe used to
    // default to false, so this test passed on any machine; now that it is wired, an
    // uncontrolled slot makes the result depend on whether the developer running the suite happens
    // to have a Claude credential in their own Keychain — which it did, here.
    const found = discoverAnthropicCredential({
      env: env(),
      home,
      keychainHasToken: () => false,
    });

    expect(found).toMatchObject({ source: "none", usable: false });
    // naming the absence without naming the fix leaves the developer guessing which
    // of four login methods this app wanted.
    expect(found.remedy).toMatch(/claude setup-token/);
    expect(found.remedy).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("covers every rung of the published precedence list", () => {
    // Guards against a slot being added to the contract and never implemented — the list is
    // shared, so this fails when the two drift rather than when someone notices.
    expect([...CREDENTIAL_PRECEDENCE]).toEqual([
      "env:ANTHROPIC_API_KEY",
      "env:ANTHROPIC_AUTH_TOKEN",
      "profile:ANTHROPIC_PROFILE",
      "profile:active",
      "env:workload-identity-federation",
      "profile:default",
    ]);
  });
});

describe("THE TRAP — an empty key claims its slot and does not fall through", () => {
  it("reports selected-and-invalid for ANTHROPIC_API_KEY=''", () => {
    writeProfile("work");
    writeCredentialsFile();

    const found = discoverAnthropicCredential({
      env: env({ ANTHROPIC_API_KEY: "", ANTHROPIC_PROFILE: "work" }),
      home,
    });

    // NOT `profile:ANTHROPIC_PROFILE`. Falling through would authenticate against the
    // profile while the developer's shell says otherwise, and every symptom would point at
    // the wrong account.
    expect(found.source).toBe("env:ANTHROPIC_API_KEY");
    expect(found.usable).toBe(false);
  });

  it("names the variable AND the fix, since the fix is counter-intuitive", () => {
    const found = discoverAnthropicCredential({ env: env({ ANTHROPIC_API_KEY: "" }), home });

    // `unset` rather than "set it correctly": the whole point is that an empty value still
    // wins, so the remedy has to say to remove it.
    expect(found.problem).toMatch(/ANTHROPIC_API_KEY is set but empty/);
    expect(found.remedy).toMatch(/unset ANTHROPIC_API_KEY/);
  });

  it("treats whitespace as empty", () => {
    const found = discoverAnthropicCredential({ env: env({ ANTHROPIC_API_KEY: "   " }), home });

    // A value of spaces authenticates with nothing exactly like `""` does, and it arrives
    // the same way — a shell variable that expanded to nothing useful.
    expect(found.usable).toBe(false);
  });

  it("applies the same rule to ANTHROPIC_AUTH_TOKEN", () => {
    writeProfile("work");

    const found = discoverAnthropicCredential({
      env: env({ ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_PROFILE: "work" }),
      home,
    });

    expect(found).toMatchObject({ source: "env:ANTHROPIC_AUTH_TOKEN", usable: false });
  });

  it("distinguishes UNSET from empty", () => {
    writeProfile("work");

    // Unset must fall through — the trap is about a variable that EXISTS and holds nothing,
    // and conflating the two would break the ordinary case for everyone.
    const found = discoverAnthropicCredential({ env: env({ ANTHROPIC_PROFILE: "work" }), home });

    expect(found).toMatchObject({ source: "profile:ANTHROPIC_PROFILE", usable: true });
  });
});

describe("a named profile that does not exist is reported, not silently skipped", () => {
  it("says which profile is missing and how to create it", () => {
    const found = discoverAnthropicCredential({ env: env({ ANTHROPIC_PROFILE: "ghost" }), home });

    // Skipping to the next slot would run against a different account than the one the
    // developer explicitly named, which is worse than failing.
    expect(found).toMatchObject({ source: "profile:ANTHROPIC_PROFILE", usable: false });
    expect(found.problem).toMatch(/"ghost"/);
    expect(found.remedy).toMatch(/ant auth login --profile ghost/);
  });
});

describe("AWS discovery for Bedrock", () => {
  it("prefers AWS_PROFILE over the credentials directory", () => {
    mkdirSync(join(home, ".aws"), { recursive: true });

    expect(discoverAwsCredential({ env: env({ AWS_PROFILE: "work" }), home })).toMatchObject({
      source: "env:AWS_PROFILE",
      usable: true,
    });
  });

  it("falls back to ~/.aws", () => {
    mkdirSync(join(home, ".aws"), { recursive: true });

    expect(discoverAwsCredential({ env: env(), home }).source).toBe("file:~/.aws");
  });

  it("warns that the harness cannot refresh an expired SSO session", () => {
    const found = discoverAwsCredential({ env: env(), home });

    // The one Bedrock failure mode a developer will hit repeatedly, and the harness has no
    // way to fix it for them — so the remedy says so instead of implying it might retry.
    expect(found.usable).toBe(false);
    expect(found.remedy).toMatch(/aws sso login/);
    expect(found.remedy).toMatch(/cannot refresh it/);
  });

  it("treats an empty AWS_PROFILE as absent, not as a claimed slot", () => {
    mkdirSync(join(home, ".aws"), { recursive: true });

    // Deliberately UNLIKE the Anthropic key trap: AWS_PROFILE names a profile rather than
    // carrying a secret, so an empty one selects nothing and the credential chain below it
    // is still correct. The asymmetry is intentional and worth pinning.
    expect(discoverAwsCredential({ env: env({ AWS_PROFILE: "" }), home }).source).toBe(
      "file:~/.aws",
    );
  });
});
