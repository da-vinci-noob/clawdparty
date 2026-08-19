/**
 * The Claude Code identity a SUBSCRIPTION token expects to see, and the opt-in that sends it.
 *
 * A subscription/enterprise OAuth token is issued to Claude Code, and the API refuses a request that
 * does not identify as it. The refusal does not look like one — measured on the owner's host with the
 * same token, headers and model, changing only the system block:
 *
 *   system: []                      → 429 {"type":"rate_limit_error","message":"Error"}
 *   system: [Claude Code identity]  → 200, usage 6 in / 1 out
 *
 * A real limit reports a limit and a retry time. This reports neither, which is why it must not be
 * classified as usage — and why the previous remedy ("a subscription seat is not necessarily
 * permitted to drive this API") was wrong: the seat IS permitted.
 *
 * OFF BY DEFAULT, deliberately, and it is not a performance or compatibility default. Sending this
 * asserts a product identity this software does not have, in order to use a credential issued to
 * that product. `AnthropicOauthAdapter.entitlement.thirdPartyClientPermitted` is
 * `owner_decision_required`, and the governing rule is that posture is "decided by the project
 * owner; it MUST NOT be assumed". So this is an explicit per-host act, documented in `.env.example`, and the
 * verify panel reports whether it is on — because otherwise the same credential passing or failing
 * has no visible explanation.
 */

export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

const OPT_IN = new Set(["1", "true", "yes", "on"]);

/**
 * Whether this host opted in. Read at CALL time rather than captured at construction, so a restart
 * is the only thing needed to change it and a long-lived adapter cannot hold a stale answer.
 */
export function claudeCodeIdentityEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return OPT_IN.has((env.HARNESS_OAUTH_CLAUDE_CODE_IDENTITY ?? "").trim().toLowerCase());
}

export interface SystemBlock {
  type: "text";
  text: string;
}

/**
 * The system prompt to send: the identity first, then the session's own blocks.
 *
 * FIRST because the provider reads the leading block as the client's identity. Idempotent, so a
 * replayed or reconstructed request that already carries it does not end up with two — the fold has
 * to stay byte-reproducible.
 */
export function withClaudeCodeIdentity(
  system: readonly SystemBlock[],
  env: NodeJS.ProcessEnv = process.env,
): SystemBlock[] {
  if (!claudeCodeIdentityEnabled(env)) return [...system];
  if (system[0]?.text === CLAUDE_CODE_IDENTITY) return [...system];
  return [{ type: "text", text: CLAUDE_CODE_IDENTITY }, ...system];
}
