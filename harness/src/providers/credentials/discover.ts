import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { CredentialSourceId } from "@clawdparty/contracts";
import { keychainHasToken } from "./keychain.js";
import {
  ENV_SOURCES,
  FILE_SOURCES,
  KEYCHAIN_SOURCE,
  NO_CREDENTIAL,
  PROFILE_DIRS,
  describeSource,
} from "./sources.js";

/**
 * Credential discovery, implemented EXPLICITLY rather than delegated to a
 * zero-arg vendor client.
 *
 * A zero-arg client resolves credentials silently.  requires the choice to
 * be explicit and  requires the winning source to be recorded per run, so
 * this implements the same documented order and reports which slot won. The
 * behaviour matches what the SDK would have done; what changes is that the answer
 * is knowable.
 *
 * Documented order, FIRST MATCH WINS (R5):
 *   ANTHROPIC_API_KEY → ANTHROPIC_AUTH_TOKEN → the ANTHROPIC_PROFILE-selected or
 *   active profile → Workload Identity Federation → the default profile on disk.
 *
 * THE TRAP, verbatim from the reference: "profiles are only consulted when no API
 * key is set. A stale exported ANTHROPIC_API_KEY silently overrides every
 * profile" — and an EMPTY `ANTHROPIC_API_KEY=""` still wins its slot and
 * authenticates with nothing. So an empty key is reported as
 * SELECTED-AND-INVALID; it must never fall through to the next slot. Falling
 * through is the silent-wrong-pick this function exists to prevent.
 */

export interface Discovery {
  /** The winning source identity. Never a value. */
  source: CredentialSourceId;
  /** False when the slot won but holds nothing usable (the empty-key trap). */
  usable: boolean;
  /** Present when `usable` is false: names the credential AND the fix. */
  problem?: string;
  remedy?: string;
}

export interface DiscoverEnv {
  env?: Record<string, string | undefined>;
  home?: string;
  os?: string;
  /** Injected so the Keychain path is testable without a real Keychain. */
  keychainHasToken?: () => boolean;
}

export function discoverAnthropicCredential(opts: DiscoverEnv = {}): Discovery {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const os = opts.os ?? platform();

  // Slot 1 + 2: env vars. Presence of the KEY is what claims the slot, not
  // whether its value is usable — that distinction is the whole trap.
  for (const [id, name] of [
    ["env:ANTHROPIC_API_KEY", ENV_SOURCES["env:ANTHROPIC_API_KEY"]],
    ["env:ANTHROPIC_AUTH_TOKEN", ENV_SOURCES["env:ANTHROPIC_AUTH_TOKEN"]],
  ] as const) {
    if (!(name in env)) continue;
    const value = env[name];
    if (value === undefined) continue;
    if (value.trim() === "") {
      return {
        source: id,
        usable: false,
        problem: `${name} is set but empty`,
        remedy:
          `${name} is exported as an empty string and still takes precedence over every ` +
          `other credential. Unset it (\`unset ${name}\`) to fall through, or give it a real value.`,
      };
    }
    return { source: id, usable: true };
  }

  // Slot 3: the ANTHROPIC_PROFILE-selected or active profile.
  const named = env.ANTHROPIC_PROFILE;
  if (named && named.trim() !== "") {
    const found = profileExists(home, named);
    return found
      ? { source: "profile:ANTHROPIC_PROFILE", usable: true }
      : {
          source: "profile:ANTHROPIC_PROFILE",
          usable: false,
          problem: `ANTHROPIC_PROFILE names "${named}", which has no profile on disk`,
          remedy: `Run \`ant auth login --profile ${named}\`, or unset ANTHROPIC_PROFILE.`,
        };
  }
  if (existsSync(join(home, PROFILE_DIRS.credentials))) {
    return { source: "profile:active", usable: true };
  }

  // Slot 4: Workload Identity Federation.
  if (env.ANTHROPIC_WIF_TOKEN_FILE || env.AWS_WEB_IDENTITY_TOKEN_FILE) {
    return { source: "env:workload-identity-federation", usable: true };
  }

  // Slot 5: the credentials file the Claude CLI writes.
  if (existsSync(join(home, FILE_SOURCES["file:~/.claude/.credentials.json"]))) {
    return { source: "file:~/.claude/.credentials.json", usable: true };
  }

  // Below the documented precedence: a Q6-only source. Not a precedence slot,
  // because a container could never reach it and the documented order predates
  // the harness being a host process.
  if (env.CLAUDE_CODE_OAUTH_TOKEN && env.CLAUDE_CODE_OAUTH_TOKEN.trim() !== "") {
    return { source: "env:CLAUDE_CODE_OAUTH_TOKEN", usable: true };
  }
  // The REAL probe by default. It defaulted to `false`, which made the slot unreachable in
  // production — so a macOS host with a subscription credential reported having none.
  if (os === KEYCHAIN_SOURCE.supportedOn && (opts.keychainHasToken ?? keychainHasToken)()) {
    return { source: KEYCHAIN_SOURCE.id, usable: true };
  }

  return {
    source: NO_CREDENTIAL,
    usable: false,
    problem: "no Anthropic credential found",
    remedy:
      "Run `claude setup-token`, or export ANTHROPIC_API_KEY, or run `ant auth login`. " +
      "The harness never mints or stores a credential — it uses the login you already have.",
  };
}

/** Codex resolves its own internal precedence via `auth_mode`, not by guessing. */
export function discoverCodexCredential(opts: DiscoverEnv = {}): Discovery {
  const home = opts.home ?? homedir();
  const path = join(home, FILE_SOURCES["file:~/.codex/auth.json"]);
  if (!existsSync(path)) {
    return {
      source: NO_CREDENTIAL,
      usable: false,
      problem: "no Codex credential found",
      remedy: "Run `codex login` to create ~/.codex/auth.json.",
    };
  }

  // The file carries BOTH an API-key slot and an OAuth token object, so which one
  // is live is read from `auth_mode` rather than inferred from which is present.
  // Only the mode is read; no token value is returned.
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { auth_mode?: string };
    if (!parsed.auth_mode) {
      return {
        source: "file:~/.codex/auth.json",
        usable: false,
        problem: "~/.codex/auth.json has no auth_mode, so the active credential is ambiguous",
        remedy: "Run `codex login` again to rewrite the file with an explicit auth_mode.",
      };
    }
    return { source: "file:~/.codex/auth.json", usable: true };
  } catch (err) {
    return {
      source: "file:~/.codex/auth.json",
      usable: false,
      problem: `~/.codex/auth.json is unreadable: ${String(err)}`,
      remedy: "Run `codex login` to rewrite it.",
    };
  }
}

export function discoverAwsCredential(opts: DiscoverEnv = {}): Discovery {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();

  if (env.AWS_PROFILE && env.AWS_PROFILE.trim() !== "") {
    return { source: "env:AWS_PROFILE", usable: true };
  }
  if (existsSync(join(home, FILE_SOURCES["file:~/.aws"]))) {
    return { source: "file:~/.aws", usable: true };
  }
  return {
    source: NO_CREDENTIAL,
    usable: false,
    problem: "no AWS credential found for Bedrock",
    remedy:
      "Run `aws sso login` or set AWS_PROFILE. Bedrock via SSO expires — the harness " +
      "cannot refresh it for you.",
  };
}

/** One line for a log or a `provider_error` remedy. Contains no value, by design. */
export function describeDiscovery(d: Discovery): string {
  return d.usable
    ? `using ${describeSource(d.source)}`
    : `${d.problem ?? "unusable credential"} (${describeSource(d.source)}) — ${d.remedy ?? ""}`;
}

function profileExists(home: string, name: string): boolean {
  return (
    existsSync(join(home, PROFILE_DIRS.credentials, name)) ||
    existsSync(join(home, PROFILE_DIRS.credentials, `${name}.json`)) ||
    existsSync(join(home, PROFILE_DIRS.configs, name)) ||
    existsSync(join(home, PROFILE_DIRS.configs, `${name}.json`))
  );
}
