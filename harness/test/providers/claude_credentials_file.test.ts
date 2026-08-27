import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnthropicDirectAdapter } from "../../src/providers/anthropic_direct.js";
import { AnthropicOauthAdapter } from "../../src/providers/anthropic_oauth.js";
import {
  discoverAnthropicCredential,
  readClaudeOauthToken,
} from "../../src/providers/credentials/discover.js";

/**
 * `~/.claude/.credentials.json` — the slot that claimed a credential it did not have.
 *
 * Found by running the harness against a real host. `/api/models` reported
 * `anthropic-direct` and `anthropic-oauth` as `unreachable` with "Check network access", while
 * the underlying error was the SDK's `Could not resolve authentication method` — thrown before
 * any request left the process. Three separate defects stacked up:
 *
 *  1. Discovery claimed the slot on `existsSync` alone. That file ALSO stores `mcpOAuth`
 *     entries for MCP server logins, so on the measured host it existed while holding no
 *     Claude login at all — and claiming the slot masked the Keychain slot below it, which
 *     was where the real credential lived.
 *  2. The adapter then built a ZERO-ARG client, on the written-down belief that "the SDK reads
 *     it itself". It does not: that file is the Claude Code CLI's, not the SDK's.
 *  3. The resulting status-less failure classified as `unreachable`, so the remedy named the
 *     network. This is the same misclassification, in a second adapter family.
 *
 * Every case uses an injected fake home and obviously-fake token material.
 */

const SAMPLE_TOKEN = "sample-oauth-token-not-real";
const FAR_FUTURE = 4_000_000_000_000;
const LONG_PAST = 1_600_000_000_000;

let home: string;

function credentialsFile(contents: unknown): void {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    typeof contents === "string" ? contents : JSON.stringify(contents),
  );
}

function claudeLogin(overrides: Record<string, unknown> = {}) {
  return {
    claudeAiOauth: {
      accessToken: SAMPLE_TOKEN,
      refreshToken: "sample-refresh-not-real",
      expiresAt: FAR_FUTURE,
      scopes: ["user:inference"],
      subscriptionType: "max",
      ...overrides,
    },
  };
}

/** The shape the measured host actually had: MCP server logins and nothing else. */
const MCP_ONLY = {
  mcpOAuth: {
    "linear|abc123": { serverName: "linear", accessToken: "", clientId: "sample-client" },
  },
};

function discover(env: Record<string, string | undefined> = {}, opts = {}) {
  return discoverAnthropicCredential({ env, home, os: "linux", ...opts });
}

/** `client()` is private to production callers; a test may still ask what it built. */
function clientOf(adapter: AnthropicOauthAdapter): Anthropic {
  return (adapter as unknown as { client(): Anthropic }).client();
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "harness-claude-creds-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("the slot is claimed on CONTENTS, not existence", () => {
  it("does not claim it for a file holding only MCP server logins", () => {
    credentialsFile(MCP_ONLY);

    // The measured case. Claiming the slot here is what produced a "check your network"
    // remedy on a host whose only fault was having no Claude login in this file.
    expect(discover()).toMatchObject({ source: "none", usable: false });
  });

  it("stops masking the Keychain slot below it", () => {
    credentialsFile(MCP_ONLY);

    // The real cost of the false positive: on macOS the credential was in the Keychain the
    // whole time, and this slot answered first.
    expect(discover({}, { os: "darwin", keychainHasToken: () => true })).toMatchObject({
      source: "keychain:anthropic-oauth",
      usable: true,
    });
  });

  it("claims it when the file holds a Claude login", () => {
    credentialsFile(claudeLogin());

    expect(discover()).toMatchObject({
      source: "file:~/.claude/.credentials.json",
      usable: true,
    });
  });

  it("reports an EXPIRED login as unusable, naming the fix", () => {
    credentialsFile(claudeLogin({ expiresAt: LONG_PAST }));

    const result = discover();
    expect(result).toMatchObject({ source: "file:~/.claude/.credentials.json", usable: false });
    // Actionable per : the credential is named and so is the action.
    expect(result.remedy).toMatch(/login|setup-token/i);
    expect(result.problem).toMatch(/expired/i);
  });

  it("reports a present-but-empty token as unusable rather than usable", () => {
    credentialsFile(claudeLogin({ accessToken: "" }));

    expect(discover()).toMatchObject({
      source: "file:~/.claude/.credentials.json",
      usable: false,
    });
  });

  it("reports an unreadable file as unusable, the way the Codex slot already does", () => {
    credentialsFile("{ this is not json");

    const result = discover();
    expect(result).toMatchObject({ source: "file:~/.claude/.credentials.json", usable: false });
    expect(result.remedy).toBeTruthy();
  });
});

describe("reading the token", () => {
  it("returns the token from the file", () => {
    credentialsFile(claudeLogin());

    expect(readClaudeOauthToken(home)).toBe(SAMPLE_TOKEN);
  });

  it("returns null when the file holds no Claude login", () => {
    credentialsFile(MCP_ONLY);

    expect(readClaudeOauthToken(home)).toBeNull();
  });

  it("returns null rather than throwing when there is no file at all", () => {
    expect(readClaudeOauthToken(home)).toBeNull();
  });
});

describe("the discovered credential is the one the client uses", () => {
  it("constructs the OAuth client WITH the file's token", () => {
    credentialsFile(claudeLogin());
    const adapter = new AnthropicOauthAdapter({
      discovery: { source: "file:~/.claude/.credentials.json", usable: true },
      home,
    });

    // The regression: a zero-arg client resolved nothing, and the SDK's own error
    // ("Could not resolve authentication method") was then reported as a network fault.
    expect(clientOf(adapter).authToken).toBe(SAMPLE_TOKEN);
  });

  it("sends the OAuth beta header with it, as the env-token path does", () => {
    credentialsFile(claudeLogin());
    const adapter = new AnthropicOauthAdapter({
      discovery: { source: "file:~/.claude/.credentials.json", usable: true },
      home,
    });

    expect(clientOf(adapter)).toHaveProperty(
      ["_options", "defaultHeaders", "anthropic-beta"],
      "oauth-2025-04-20",
    );
  });
});

describe("the direct adapter declines a login that is not its own", () => {
  it("names the host-login path instead of probing with no credential", async () => {
    credentialsFile(claudeLogin());
    const adapter = new AnthropicDirectAdapter({
      discovery: { source: "file:~/.claude/.credentials.json", usable: true },
    });

    // Symmetric with what the OAuth adapter already does when an API key wins: an adapter
    // that has nothing to serve says so, instead of producing a second confusing failure for
    // the same cause.
    const probe = await adapter.probe();
    expect(probe).toMatchObject({ available: false, reason: "no_credential" });
    expect(probe).toHaveProperty("remedy", expect.stringMatching(/host login|subscription/i));
  });
});
