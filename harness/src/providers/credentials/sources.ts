import { CREDENTIAL_PRECEDENCE, type CredentialSourceId } from "@clawdparty/contracts";

/**
 * Credential source IDENTITIES. This file handles no values — it names places.
 *
 * That separation is the point: `credential_source` is recorded on every run
 * so "which login did this use?" is answerable from the record, while
 * the value never enters the record at all. Keeping the identities in a
 * file that cannot read a secret makes the rule structural rather than a habit.
 */

export type { CredentialSourceId };
export { CREDENTIAL_PRECEDENCE };

/** Environment variables consulted, in precedence order. */
export const ENV_SOURCES = {
  "env:ANTHROPIC_API_KEY": "ANTHROPIC_API_KEY",
  "env:ANTHROPIC_AUTH_TOKEN": "ANTHROPIC_AUTH_TOKEN",
  "env:CLAUDE_CODE_OAUTH_TOKEN": "CLAUDE_CODE_OAUTH_TOKEN",
  "env:AWS_PROFILE": "AWS_PROFILE",
} as const satisfies Partial<Record<CredentialSourceId, string>>;

/**
 * On-disk locations, `~`-relative. Read DIRECTLY — under Q6 the harness is a host
 * process, so there is no bind mount anywhere in the credential path. Reading is
 * permitted; copying, logging, or forwarding is not.
 */
export const FILE_SOURCES = {
  "file:~/.claude/.credentials.json": ".claude/.credentials.json",
  "file:~/.codex/auth.json": ".codex/auth.json",
  "file:~/.aws": ".aws",
} as const satisfies Partial<Record<CredentialSourceId, string>>;

/** Anthropic CLI profile directories (`ant auth login`). */
export const PROFILE_DIRS = {
  configs: ".config/anthropic/configs",
  credentials: ".config/anthropic/credentials",
} as const;

/**
 * macOS Keychain, reachable ONLY because the harness runs on the host (Q6/R13).
 * A container cannot read the Keychain under any mount configuration, which is
 * why the pre-Q6 docs told developers to run `claude setup-token` and export a
 * token by hand. 's "including locations a container cannot reach" is
 * satisfiable rather than aspirational because of this entry.
 */
export const KEYCHAIN_SOURCE = {
  id: "keychain:anthropic-oauth" as const satisfies CredentialSourceId,
  /**
   * MEASURED, not guessed. This was `"Claude Code"`, which does not exist — checked on a host
   * that has the credential: `security find-generic-password -s "Claude Code"` finds nothing, while
   * `-s "Claude Code-credentials"` finds the item. So the slot was doubly broken: unreachable
   * because its probe defaulted to false, AND keyed on a name that would never have matched.
   */
  service: "Claude Code-credentials",
  supportedOn: "darwin" as const,
};

export const NO_CREDENTIAL = "none" as const satisfies CredentialSourceId;

/** Human-facing description of a source, for a remedy message. */
export function describeSource(id: CredentialSourceId): string {
  if (id === NO_CREDENTIAL) return "no credential";
  const [kind, rest] = splitOnce(id, ":");
  switch (kind) {
    case "env":
      return `the ${rest} environment variable`;
    case "file":
      return `the file ${rest}`;
    case "profile":
      return rest === "default" ? "the default Anthropic profile" : `the Anthropic profile ${rest}`;
    case "keychain":
      return "the macOS Keychain";
    default:
      return id;
  }
}

function splitOnce(value: string, sep: string): [string, string] {
  const at = value.indexOf(sep);
  return at === -1 ? [value, ""] : [value.slice(0, at), value.slice(at + sep.length)];
}
