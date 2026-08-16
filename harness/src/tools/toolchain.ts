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
 * The environment a bash tool call runs with: the host env, plus `CLAWDPARTY_SESSION`,
 * plus any shim dirs PREPENDED to PATH.
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

  return {
    ...base,
    CLAWDPARTY_SESSION: "1",
    PATH: missing.length === 0 ? currentPath : [...missing, currentPath].join(delimiter),
  };
}
