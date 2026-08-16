import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_BEDROCK_MEASURED_AT,
  isServableAnthropicProfile,
  supportsAdaptiveThinking,
} from "../../src/providers/anthropic_bedrock_capabilities.js";

/**
 * Anthropic capabilities on Bedrock are PER MODEL, not per provider.
 *
 * `BEDROCK_CAPABILITIES` was one static table applied to all 20+ Anthropic inference profiles,
 * declaring `adaptiveThinking: true` and the full `effortLevels` for every one. That is true for
 * the newest models and false for the rest, so selecting Opus 4.1 sent
 * `thinking: {type:"adaptive"}` and the API refused the whole request:
 *
 *     400 thinking: Input tag 'adaptive' found using 'type' does not match any of the
 *     expected tags: 'enabled', 'disabled'
 *
 * Measured 2026-08-17 in us-west-2 by probing every Anthropic profile with `thinking.adaptive`
 * and with `output_config.effort`. The two track each other exactly — a model accepts both or
 * neither — so one predicate gates both.
 *
 * Two profiles cannot serve a request AT ALL and must not be offered : `claude-3-sonnet`
 * is 404 end-of-life, and `claude-fable-5` is `400 data retention mode 'default' is not
 * available for this model` on a PLAIN request, so no capability flag can rescue it.
 */

describe("adaptive thinking and effort", () => {
  it("holds for the models measured to accept it", () => {
    for (const id of [
      "us.anthropic.claude-opus-4-6-v1",
      "global.anthropic.claude-opus-4-6-v1",
      "us.anthropic.claude-opus-4-7",
      "global.anthropic.claude-opus-4-7",
      "us.anthropic.claude-opus-4-8",
      "us.anthropic.claude-opus-5",
      "global.anthropic.claude-opus-5",
      "us.anthropic.claude-sonnet-4-6",
      "global.anthropic.claude-sonnet-4-6",
      "us.anthropic.claude-sonnet-5",
    ]) {
      expect(supportsAdaptiveThinking(id), id).toBe(true);
    }
  });

  it("is FALSE for the models that refuse it", () => {
    // Each of these returned a 400 on a request carrying `thinking: {type:"adaptive"}`.
    for (const id of [
      "us.anthropic.claude-opus-4-1-20250805-v1:0",
      "us.anthropic.claude-opus-4-5-20251101-v1:0",
      "global.anthropic.claude-opus-4-5-20251101-v1:0",
      "us.anthropic.claude-sonnet-4-20250514-v1:0",
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    ]) {
      expect(supportsAdaptiveThinking(id), id).toBe(false);
    }
  });

  it("does not confuse opus-4-5 with opus-5, or sonnet-4-5 with sonnet-5", () => {
    // The version numbering makes naive substring matching wrong in a way that costs a whole
    // model family: `opus-4-5` must not match an `opus-5` rule.
    expect(supportsAdaptiveThinking("us.anthropic.claude-opus-4-5-20251101-v1:0")).toBe(false);
    expect(supportsAdaptiveThinking("us.anthropic.claude-opus-5")).toBe(true);
    expect(supportsAdaptiveThinking("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(false);
    expect(supportsAdaptiveThinking("us.anthropic.claude-sonnet-5")).toBe(true);
  });

  it("defaults to FALSE for an unmeasured model", () => {
    // The safe direction: omitting `thinking` works on every model, while sending an
    // unsupported one is a 400 that kills the run. A wrong false costs a feature; a wrong true
    // costs the turn.
    expect(supportsAdaptiveThinking("us.anthropic.claude-opus-9-released-tomorrow")).toBe(false);
  });
});

describe("profiles this host cannot serve", () => {
  it("excludes an end-of-life model", () => {
    // 404 This model version has reached the end of its life.
    expect(isServableAnthropicProfile("us.anthropic.claude-3-sonnet-20240229-v1:0")).toBe(false);
  });

  it("excludes every claude-3 profile, which is the whole EOL generation", () => {
    expect(isServableAnthropicProfile("us.anthropic.claude-3-haiku-20240307-v1:0")).toBe(false);
  });

  it("excludes fable-5, which refuses even a plain request here", () => {
    // `400 data retention mode 'default' is not available for this model` — an account
    // posture, not a capability, so no flag makes it work. : do not offer it.
    expect(isServableAnthropicProfile("us.anthropic.claude-fable-5")).toBe(false);
    expect(isServableAnthropicProfile("global.anthropic.claude-fable-5")).toBe(false);
  });

  it("keeps every profile measured to answer a plain request", () => {
    for (const id of [
      "us.anthropic.claude-opus-4-1-20250805-v1:0",
      "us.anthropic.claude-opus-4-5-20251101-v1:0",
      "us.anthropic.claude-sonnet-4-20250514-v1:0",
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      "us.anthropic.claude-opus-5",
      "us.anthropic.claude-sonnet-5",
    ]) {
      expect(isServableAnthropicProfile(id), id).toBe(true);
    }
  });

  it("is dated, so a stale table is visible rather than assumed current", () => {
    expect(ANTHROPIC_BEDROCK_MEASURED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
