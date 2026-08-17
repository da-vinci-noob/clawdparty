import { execFileSync } from "node:child_process";
import { KEYCHAIN_SOURCE } from "./sources.js";

/**
 * Does a Claude OAuth credential EXIST in the macOS Keychain?
 *
 * names the Keychain as a location a container cannot reach, which is one of the reasons the
 * harness runs as a host process. The slot for it has existed in `discoverAnthropicCredential`
 * since M3 with its probe injected and defaulting to FALSE — so it was unreachable in production,
 * and `anthropic-oauth` reported itself unavailable on exactly the hosts where the credential was
 * present.
 *
 * Two operations, deliberately separate. `keychainHasToken` is the DISCOVERY probe: metadata only,
 * never `-w`, because deciding which slot wins needs no secret. `readKeychainToken` is the one caller
 * that must have the value — the adapter building its client — and it exists because the reason for
 * withholding it turned out to be false.
 *
 * **The premise that used to justify existence-only was wrong.** It read: "`client()` constructs the
 * vendor client with NO token for this path — the SDK resolves the credential itself." The SDK reads
 * neither this Keychain item nor `~/.claude/.credentials.json` (both are Claude Code's, not the
 * SDK's); a zero-arg client throws `Could not resolve authentication method` before sending anything.
 * So the credential was DISCOVERED and unusable, and a developer running the remedy the harness
 * printed (`claude setup-token`, which stores here) stayed at `no_credential`.
 *
 * still holds and is not in tension with this: the harness neither mints, persists, nor
 * transmits a credential. It reads one the developer already has, holds it only long enough to
 * construct a client, and records the SOURCE — never the value.
 *
 * **Why this file may start a process** — `no_shell_input.test.ts` used to require every
 * process-starter to live under `tools/`, which would have refused this on its path rather than on
 * anything it does. That rule is now the property that actually matters: on the allowlist, argv
 * form, no interpolated input. This file satisfies all three — the argv is fixed, and the only
 * variable in it is a module constant.
 */

/** The exact argv. A constant, so there is nothing for a caller to influence. */
export const KEYCHAIN_QUERY = ["find-generic-password", "-s", KEYCHAIN_SOURCE.service] as const;

/** The same query plus `-w`, which is what prints the password. Also a constant. */
export const KEYCHAIN_READ_QUERY = [...KEYCHAIN_QUERY, "-w"] as const;

export const SECURITY_BIN = "/usr/bin/security";

/** Injected in tests; production uses `execFileSync`. Returns the exit code. */
export type SecurityRunner = (bin: string, args: readonly string[]) => number;

const defaultRunner: SecurityRunner = (bin, args) => {
  try {
    // `stdio: "ignore"` on every stream: the item's METADATA is of no interest either, and not
    // capturing output is the cheapest guarantee that nothing from the Keychain reaches a log.
    execFileSync(bin, [...args], { stdio: "ignore", timeout: 5_000 });
    return 0;
  } catch (err) {
    // Exit 44 is `security`'s "item not found", which is an ANSWER rather than a failure. Any other
    // code (missing binary, locked keychain, timeout) is also reported as "no credential here",
    // because discovery's question is only ever whether this slot can serve.
    return (err as { status?: number } | null)?.status ?? 1;
  }
};

/**
 * True when the Keychain holds a Claude Code credential.
 *
 * Never throws: discovery walks a precedence list, so a failure in one slot must let the next be
 * tried rather than taking the whole walk down.
 */
export function keychainHasToken(runner: SecurityRunner = defaultRunner): boolean {
  if (process.platform !== KEYCHAIN_SOURCE.supportedOn) {
    return false;
  }
  try {
    return runner(SECURITY_BIN, KEYCHAIN_QUERY) === 0;
  } catch {
    return false;
  }
}

/** Injected in tests; production uses `execFileSync`. Returns the raw stored value, or null. */
export type SecretReader = (bin: string, args: readonly string[]) => string | null;

const defaultReader: SecretReader = (bin, args) => {
  try {
    // stdout PIPED because the value is the point; stderr IGNORED because a Keychain refusal names
    // the item and the calling app, and none of that should be able to reach a log. The timeout is
    // load-bearing rather than defensive: the item was created by another application, so this read
    // can hit an ACL that prompts for confirmation — and a prompt nobody can answer would otherwise
    // hang the agent loop.
    return execFileSync(bin, [...args], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
};

/**
 * A read that FAILED, remembered process-wide.
 *
 * `buildAdapters` returns fresh instances per call, so per-instance memoisation still means one spawn
 * per `/api/models`, per `/verify` and per run start. Fine when the read succeeds quietly; not fine
 * when the item's ACL PROMPTS — that would be a macOS confirmation dialog on every page load, from a
 * process the developer cannot see.
 *
 * Only the FAILURE is cached, never the token: remembering "this did not work" costs nothing, while
 * remembering the value would keep a credential in memory long after the client that needed it was
 * built. The cost of the asymmetry is that a Keychain fixed mid-run is not retried until
 * `bin/harness` restarts — acceptable, because the remedy tells the developer to export a token and
 * restart anyway, and `forgetKeychainFailure()` exists for the cases that should not have to.
 */
let readFailed = false;

/** Clear the negative cache. For tests, and for a caller that has reason to believe it changed. */
export function forgetKeychainFailure(): void {
  readFailed = false;
}

/**
 * The Claude OAuth token from the Keychain, or null.
 *
 * Handles BOTH stored shapes. Claude Code stores a JSON blob (the same `claudeAiOauth` object it
 * writes to the credentials file), and `claude setup-token` can leave a bare token — neither shape is
 * ours to guarantee, so both are accepted and anything else is null rather than a guess.
 *
 * Never throws, never logs, and returns null on an expired token: sending a dead credential produces
 * a 401 the participant then has to interpret, when discovery could have said so up front.
 */
export function readKeychainToken(reader: SecretReader = defaultReader): string | null {
  if (process.platform !== KEYCHAIN_SOURCE.supportedOn || readFailed) {
    return null;
  }
  let raw: string | null;
  try {
    raw = reader(SECURITY_BIN, KEYCHAIN_READ_QUERY);
  } catch {
    readFailed = true;
    return null;
  }
  const value = raw?.trim();
  if (!value) {
    readFailed = true;
    return null;
  }

  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as {
        claudeAiOauth?: { accessToken?: string; expiresAt?: number };
      };
      const block = parsed.claudeAiOauth;
      const token = block?.accessToken?.trim();
      if (!token) {
        readFailed = true;
        return null;
      }
      // An EXPIRED token is not cached as a failure: it becomes valid again the moment the developer
      // re-runs `claude setup-token`, and making them restart the harness for that would be gratuitous.
      if (typeof block?.expiresAt === "number" && block.expiresAt <= Date.now()) return null;
      return token;
    } catch {
      readFailed = true;
      return null;
    }
  }
  return value;
}
