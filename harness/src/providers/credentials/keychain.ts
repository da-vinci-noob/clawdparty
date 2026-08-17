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
 * **EXISTENCE ONLY. This never reads the secret, and that is the design, not a limitation.**
 * `anthropic_oauth.client()` constructs the vendor client with NO token for this path — the SDK
 * resolves the credential itself — so all discovery needs is whether there is one to find. Reading
 * the value would put a credential in this process for no purpose, and  says the harness
 * neither mints, persists, nor transmits one.
 *
 * Concretely: the command is `security find-generic-password -s <service>` and NEVER `-w`, which is
 * the flag that prints the password. A test asserts that.
 *
 * **Why this file may start a process** — `no_shell_input.test.ts` used to require every
 * process-starter to live under `tools/`, which would have refused this on its path rather than on
 * anything it does. That rule is now the property that actually matters: on the allowlist, argv
 * form, no interpolated input. This file satisfies all three — the argv is fixed, and the only
 * variable in it is a module constant.
 */

/** The exact argv. A constant, so there is nothing for a caller to influence. */
export const KEYCHAIN_QUERY = ["find-generic-password", "-s", KEYCHAIN_SOURCE.service] as const;

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
