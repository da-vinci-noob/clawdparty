import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * a command Claude runs must resolve the same tool versions the
 * developer gets in their own shell.
 *
 * `bash -lc` is a LOGIN shell, which is what picks up a toolchain configured in a
 * profile. That is necessary but not sufficient, and on a real machine it is usually
 * not enough: version managers are typically activated in an INTERACTIVE rc file
 * (`.zshrc`), which no non-interactive shell sources, and the developer's shell is
 * often not bash at all. Measured on this host: in `bash -lc`, `MISE_SHELL` is unset,
 * a project `mise.toml` `[env]` block has no effect, and no mise directory appears on
 * PATH — so a version-manager-pinned project would resolve the SYSTEM tool instead.
 *
 * SHIM DIRECTORIES are the fix, and they are why shims exist: a shim resolves the
 * right version from the project config with no shell activation at all, in any shell.
 * Prepending the ones that exist is tool-agnostic and does nothing on a machine that
 * has none.
 *
 * Deliberately NOT `spawn($SHELL, ["-lc", ...])`: `-lc` is not portable across shells
 * (fish takes neither flag the same way), a login zsh still would not read `.zshrc`
 * where activation usually lives, and it would swap the one shell whose behaviour
 * `no_shell_input.test.ts` pins. Shims solve the actual problem — version resolution —
 * without changing what the harness executes.
 */

/** Shim dirs in precedence order. First match wins for a given binary name. */
export function shimDirs(home: string = homedir()): string[] {
  return [
    join(home, ".local", "share", "mise", "shims"), // mise
    join(home, ".asdf", "shims"), // asdf
    join(home, ".rbenv", "shims"),
    join(home, ".pyenv", "shims"),
  ].filter((dir) => existsSync(dir));
}

/**
 * Auth material the HARNESS uses to reach a provider, withheld from tool subprocesses
 *.
 *
 * The harness is the only legitimate consumer of these: a command Claude runs has no
 * reason to authenticate as the developer to a model API. Leaving them in the child made
 * `printenv ANTHROPIC_API_KEY` — or any `env` during ordinary debugging — write the
 * developer's live key into a durable entry and broadcast it to every participant,
 * including a `viewer` invited by link.
 *
 * Removing the variable beats redacting the output. A pattern list cannot catch `base64`
 * of the same value, and it has to be extended for every credential format that ever
 * ships; a variable that is not in the child cannot be encoded out of it.
 *
 * The AWS entries are the whole env credential chain, not just the secret. Dropping only
 * `AWS_SECRET_ACCESS_KEY` leaves a half-set chain that the SDK prefers and then fails on,
 * instead of falling through to `~/.aws` — so a repo task using the `aws` CLI still works
 * via `AWS_PROFILE` plus the credentials file, which are deliberately KEPT.
 */
export const WITHHELD_FROM_TOOLS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
] as const;

/**
 * The environment a bash tool call runs with: the host env MINUS the harness's own auth
 * material, plus `CLAWDPARTY_SESSION`, plus any shim dirs PREPENDED to PATH.
 *
 * Prepended, not appended: a system Node earlier on PATH would win and the pinned
 * version would never be reached, which is the exact failure this prevents.
 */
export function toolchainEnv(
  base: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): NodeJS.ProcessEnv {
  const dirs = shimDirs(home);
  const currentPath = base.PATH ?? "";
  const alreadyPresent = currentPath.split(delimiter);
  const missing = dirs.filter((dir) => !alreadyPresent.includes(dir));

  const env: NodeJS.ProcessEnv = {
    ...base,
    CLAWDPARTY_SESSION: "1",
    PATH: missing.length === 0 ? currentPath : [...missing, currentPath].join(delimiter),
  };
  // Deleted, not set to "": an empty value still tells a reader the variable exists and
  // some SDKs treat it as a present-but-broken credential rather than an absent one.
  for (const key of WITHHELD_FROM_TOOLS) delete env[key];
  return env;
}
