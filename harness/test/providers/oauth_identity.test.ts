import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnthropicOauthAdapter } from "../../src/providers/anthropic_oauth.js";
import {
  CLAUDE_CODE_IDENTITY,
  claudeCodeIdentityEnabled,
} from "../../src/providers/oauth_identity.js";

/**
 * A SUBSCRIPTION token drives the API only if the request identifies as Claude Code, and the
 * provider's way of saying so is a 429 that is not a rate limit.
 *
 * Measured on the owner's host, same token and headers and model, one 1-token request each:
 *
 *   system: []                      → 429 {"type":"rate_limit_error","message":"Error"}
 *   system: [Claude Code identity]  → 200, usage 6 in / 1 out
 *
 * So the credential IS permitted to drive this API, and the earlier reading — "a subscription seat
 * is not necessarily permitted, which is the account owner's decision to check" — was confidently
 * wrong advice, the same defect this repo has fixed three times over: a remedy that sends the developer
 * somewhere the problem is not. A real limit reports a limit and a retry time; this reports neither,
 * which the classifier already noticed and then drew the wrong conclusion from.
 *
 * OFF BY DEFAULT, and that is the whole point of the flag. Sending the identity means asserting a
 * product identity this software does not have, in order to use a credential issued to that product.
 * `thirdPartyClientPermitted` is `owner_decision_required` and the entitlement rule says posture "MUST NOT
 * be assumed" — so the decision is the account owner's, taken once, explicitly, and recorded. Owner
 * decided 2026-08-20: implement it, default off, opt in per host.
 */

const ORIGINAL = process.env.HARNESS_OAUTH_CLAUDE_CODE_IDENTITY;

// UNSET, not `= undefined`: Node coerces env values to strings, so assigning undefined leaves the
// var PRESENT as the string "undefined" — the opposite of opt-in-absent. `Reflect.deleteProperty`
// removes the key like `delete` does, without the `delete` operator `noDelete` forbids.
const KEY = "HARNESS_OAUTH_CLAUDE_CODE_IDENTITY";

beforeEach(() => {
  Reflect.deleteProperty(process.env, KEY);
});
afterEach(() => {
  if (ORIGINAL === undefined) Reflect.deleteProperty(process.env, KEY);
  else process.env[KEY] = ORIGINAL;
});

describe("the identity is opt-in", () => {
  it("is OFF when nothing is set", () => {
    expect(claudeCodeIdentityEnabled()).toBe(false);
  });

  it("is off for values that are not an opt-in", () => {
    for (const value of ["0", "false", "", "no"]) {
      process.env.HARNESS_OAUTH_CLAUDE_CODE_IDENTITY = value;
      expect(claudeCodeIdentityEnabled(), `value ${JSON.stringify(value)}`).toBe(false);
    }
  });

  it("is on for an explicit opt-in", () => {
    for (const value of ["1", "true", "yes"]) {
      process.env.HARNESS_OAUTH_CLAUDE_CODE_IDENTITY = value;
      expect(claudeCodeIdentityEnabled(), `value ${value}`).toBe(true);
    }
  });
});

describe("what the request carries", () => {
  const adapter = new AnthropicOauthAdapter();

  it("prepends the identity FIRST, keeping the session's own prompt", () => {
    process.env.HARNESS_OAUTH_CLAUDE_CODE_IDENTITY = "1";
    const own = [{ type: "text" as const, text: "You are in a clawdparty session." }];

    const system = adapter.systemFor(own);

    // First, not appended: the provider reads the leading block as the client's identity.
    expect(system[0]).toEqual({ type: "text", text: CLAUDE_CODE_IDENTITY });
    expect(system).toHaveLength(2);
    expect(system[1]).toEqual(own[0]);
  });

  it("passes the system prompt through UNTOUCHED when the flag is off", () => {
    const own = [{ type: "text" as const, text: "You are in a clawdparty session." }];

    expect(adapter.systemFor(own)).toEqual(own);
  });

  it("does not double-prepend when the identity is already leading", () => {
    // A caller that already supplied it (a replayed request, a reconstruction) must not end up
    // with two identity blocks — the fold has to stay byte-reproducible.
    process.env.HARNESS_OAUTH_CLAUDE_CODE_IDENTITY = "1";
    const already = [{ type: "text" as const, text: CLAUDE_CODE_IDENTITY }];

    expect(adapter.systemFor(already)).toEqual(already);
  });

  it("still sends the identity when the session prompt is EMPTY", () => {
    // The measured failing case: `verify.ts` sends `system: []`, so an implementation that only
    // decorated a non-empty prompt would leave the probe failing exactly as before.
    process.env.HARNESS_OAUTH_CLAUDE_CODE_IDENTITY = "1";

    expect(adapter.systemFor([])).toEqual([{ type: "text", text: CLAUDE_CODE_IDENTITY }]);
  });
});
