import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * OPTIONAL macOS sandbox for model-directed `bash` — defense in depth, OFF BY DEFAULT.
 *
 * The containment boundary is `tool:before` (by design: "the tool-gating extension points
 * become the primary containment mechanism"). This is a weaker second layer under it,
 * and the profile is a DENY-LIST, so anything unnamed is permitted. If a command must
 * not run, refuse it at the gate.
 *
 * It FAILS OPEN. When enabled but unavailable — not macOS, no `sandbox-exec`, missing
 * profile — the command runs unsandboxed with a logged reason rather than being refused.
 * That is right for a layer that is explicitly not the boundary: refusing all `bash` on
 * Linux because a macOS-only facility is missing would break the product to protect
 * nothing. It is also exactly why this must not be relied on as the boundary — a layer
 * that can silently be absent cannot be one.
 */

const PROFILE = fileURLToPath(new URL("../../sandbox/bash.sb", import.meta.url));
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export interface BashInvocation {
  bin: string;
  args: string[];
  /** Set when the sandbox was REQUESTED but could not be applied. */
  unavailable?: string;
}

export interface SandboxOptions {
  env?: NodeJS.ProcessEnv;
  platform?: string;
  home?: string;
  /** Injectable for tests; defaults to a real filesystem check. */
  exists?: (path: string) => boolean;
}

function requested(env: NodeJS.ProcessEnv): boolean {
  const value = (env.HARNESS_BASH_SANDBOX ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/**
 * How to invoke bash for one command.
 *
 * `command` is always a STANDALONE ARRAY ELEMENT and never interpolated into the
 * invocation, sandboxed or not — that property is what `no_shell_input.test.ts` pins,
 * and adding a wrapper must not weaken it.
 */
export function bashInvocation(command: string, opts: SandboxOptions = {}): BashInvocation {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const exists = opts.exists ?? existsSync;

  const plain: BashInvocation = { bin: "bash", args: ["-lc", command] };
  if (!requested(env)) return plain;

  if (platform !== "darwin") {
    return {
      ...plain,
      unavailable: `HARNESS_BASH_SANDBOX is set but sandbox-exec is macOS-only (platform: ${platform})`,
    };
  }
  if (!exists(SANDBOX_EXEC)) {
    return { ...plain, unavailable: `HARNESS_BASH_SANDBOX is set but ${SANDBOX_EXEC} is missing` };
  }
  if (!exists(PROFILE)) {
    return {
      ...plain,
      unavailable: `HARNESS_BASH_SANDBOX is set but the profile is missing: ${PROFILE}`,
    };
  }

  return {
    bin: SANDBOX_EXEC,
    args: [
      "-f",
      PROFILE,
      // The profile is parameterised rather than hardcoding paths, so it holds for any
      // developer's home and any HARNESS_STORE_DIR.
      "-D",
      `HOME=${home}`,
      "-D",
      `STORE_DIR=${storeDir(env, home)}`,
      "/bin/bash",
      "-lc",
      command,
    ],
  };
}

/** Mirrors config.ts's default so the profile protects the store wherever it lives. */
function storeDir(env: NodeJS.ProcessEnv, home: string): string {
  return env.HARNESS_STORE_DIR ?? `${home}/.local/state/clawdparty/sessions`;
}

export const SANDBOX_PROFILE_PATH = PROFILE;
