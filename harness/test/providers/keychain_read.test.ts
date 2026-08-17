import { describe, expect, it } from "vitest";
import { AnthropicOauthAdapter } from "../../src/providers/anthropic_oauth.js";
import {
  KEYCHAIN_READ_QUERY,
  SECURITY_BIN,
  readKeychainToken,
} from "../../src/providers/credentials/keychain.js";
import { KEYCHAIN_SOURCE } from "../../src/providers/credentials/sources.js";

/**
 * Reading the Keychain credential, not merely detecting it.
 *
 * The probe has long existed and deliberately never read the secret, on the written-down
 * ground that "`anthropic_oauth.client()` constructs the vendor client with NO token for this path —
 * the SDK resolves the credential itself". That premise is FALSE, measured earlier the same way it
 * was measured for `~/.claude/.credentials.json`: the SDK reads neither, and a zero-arg client throws
 * `Could not resolve authentication method` before sending anything.
 *
 * The other stated blocker was also stale. `no_shell_input.test.ts` used to require every
 * process-starter to live under `tools/`; that was replaced with "on the allowlist AND argv-form
 * with no interpolated input" *specifically* so a Keychain reader would be judged on its shape, and
 * `credentials/keychain.ts` is already on that allowlist.
 *
 * Consequence, measured on this host: `claude setup-token` stores the credential in the Keychain, so
 * a developer who runs the exact remedy the harness printed is still told `no_credential`.
 *
 * EVERY case here uses an INJECTED runner. No test reads a real Keychain — that would make the suite
 * depend on whose machine it runs on, and would materialise a live credential to prove a code path.
 */

const SAMPLE = "sample-keychain-token-not-real";

/** What Claude Code actually stores: a JSON blob, not a bare token. Both shapes are handled. */
const JSON_BLOB = JSON.stringify({
  claudeAiOauth: { accessToken: SAMPLE, expiresAt: 4_000_000_000_000 },
});

describe("the read command", () => {
  it("asks for the password with -w, in argv form with no interpolation", () => {
    // The probe's argv deliberately omits `-w`; the reader's deliberately includes it. Both are
    // constants, which is what keeps this file on the no-shell-input allowlist.
    expect(KEYCHAIN_READ_QUERY).toEqual([
      "find-generic-password",
      "-s",
      KEYCHAIN_SOURCE.service,
      "-w",
    ]);
    expect(SECURITY_BIN).toBe("/usr/bin/security");
  });
});

describe("what the reader returns", () => {
  it("extracts the access token from the JSON blob Claude Code stores", () => {
    expect(readKeychainToken(() => JSON_BLOB)).toBe(SAMPLE);
  });

  it("accepts a bare token too, since the stored shape is not ours to guarantee", () => {
    expect(readKeychainToken(() => `  ${SAMPLE}\n`)).toBe(SAMPLE);
  });

  it("returns null when the item holds JSON with no Claude login in it", () => {
    expect(readKeychainToken(() => JSON.stringify({ mcpOAuth: {} }))).toBeNull();
  });

  it("returns null on an empty or whitespace value rather than an empty token", () => {
    expect(readKeychainToken(() => "")).toBeNull();
    expect(readKeychainToken(() => "   \n")).toBeNull();
  });

  it("returns null — never throws — when the read fails", () => {
    // The failure that matters is a DENIED or PROMPTING keychain: the item was created by another
    // app, so the ACL may refuse a read from this process. Discovery walks a precedence list, so one
    // slot failing must not take the walk down, and a prompt must not hang the loop (hence the
    // timeout in the default runner).
    expect(
      readKeychainToken(() => {
        throw new Error("User interaction is not allowed.");
      }),
    ).toBeNull();
  });

  it("returns null when the token is expired, rather than sending a dead credential", () => {
    const expired = JSON.stringify({
      claudeAiOauth: { accessToken: SAMPLE, expiresAt: 1_600_000_000_000 },
    });

    expect(readKeychainToken(() => expired)).toBeNull();
  });
});

describe("the adapter uses it", () => {
  const keychainDiscovery = { source: KEYCHAIN_SOURCE.id, usable: true } as const;

  it("constructs the client with the Keychain's token", () => {
    const adapter = new AnthropicOauthAdapter({
      discovery: keychainDiscovery,
      readKeychain: () => JSON_BLOB,
    });

    expect((adapter as unknown as { client(): { authToken?: string } }).client().authToken).toBe(
      SAMPLE,
    );
  });

  it("still refuses with the working remedy when the read yields nothing", async () => {
    const adapter = new AnthropicOauthAdapter({
      discovery: keychainDiscovery,
      readKeychain: () => null,
    });

    // Degradation, not a crash: a denied ACL leaves the developer exactly where they were, and the
    // remedy that does work is the one they should see.
    const probe = await adapter.probe();
    expect(probe).toMatchObject({ available: false, reason: "no_credential" });
    expect(probe).toHaveProperty("remedy", expect.stringMatching(/CLAUDE_CODE_OAUTH_TOKEN/));
  });

  it("records the SOURCE and never the secret", async () => {
    // what reaches the record is an identity. A probe result carrying the token would put it
    // into `request_header` and from there into the store.
    const adapter = new AnthropicOauthAdapter({
      discovery: keychainDiscovery,
      readKeychain: () => JSON_BLOB,
      client: {
        models: { list: async () => ({ data: [] }) },
      } as never,
    });

    const probe = await adapter.probe();
    expect(JSON.stringify(probe)).not.toContain(SAMPLE);
    expect(probe).toMatchObject({ available: true, credentialSource: KEYCHAIN_SOURCE.id });
  });
});
