import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnthropicBedrockAdapter } from "../src/providers/anthropic_bedrock.js";
import { BedrockConverseAdapter } from "../src/providers/bedrock_converse.js";

/**
 * The per-run AWS profile reaches the SDK — the last link of the chain that decides WHOSE ACCOUNT
 * PAYS.
 *
 * The chain is: Rails `Runs::Start` sends `aws_profile` (asserted in `start_defaults_spec.rb`) →
 * `Supervisor.startRun` hands it to `adapterFor` → `buildAdapters({ awsProfile })` → the adapter
 * builds its client with `fromIni({ profile })`. Both ADAPTERS were already covered; the middle
 * hop was covered by nothing, and it is the one that silently drops a field — exactly how
 * `allowed_tools`, `connectors` and `skills` each turned out to be accepted and ignored.
 *
 * A live check cannot close it here: every profile on a developer's machine that resolves at all
 * resolves to an account that works, so a passing run proves nothing about which profile was used.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "profile-chain-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("both Bedrock adapters take an explicit profile over the host default", () => {
  it("anthropic-bedrock", () => {
    const adapter = new AnthropicBedrockAdapter({
      env: { AWS_REGION: "us-west-2", AWS_PROFILE: "host-default" },
      awsProfile: "chosen-for-this-run",
      discovery: { source: "env:AWS_PROFILE", usable: true },
    });
    expect(adapter.profileForTest()).toBe("chosen-for-this-run");
  });

  it("bedrock-converse", () => {
    const adapter = new BedrockConverseAdapter({
      env: { AWS_REGION: "us-west-2", AWS_PROFILE: "host-default" },
      awsProfile: "chosen-for-this-run",
      discovery: { source: "env:AWS_PROFILE", usable: true },
    });
    expect(adapter.profileForTest()).toBe("chosen-for-this-run");
  });
});

describe("the supervisor hop", () => {
  it("passes the RUN's profile into adapter construction", () => {
    // A source assertion, because the seam is not otherwise reachable: `adapterFor` builds the
    // adapters internally, and an injected adapter (what every other supervisor test uses) bypasses
    // the profile entirely — so a behavioural test here would pass with the argument deleted.
    const source = readFileSync(new URL("../src/supervisor.ts", import.meta.url), "utf8");

    expect(source).toMatch(/adapterFor\(input\.provider, input\.aws_profile\)/);
    expect(source).toMatch(/buildAdapters\(\{ awsProfile \}\)/);
  });

  it("never selects a profile from the ambient environment inside a run", () => {
    // One harness process serves many sessions: reading `process.env.AWS_PROFILE` at run time (or
    // worse, mutating it) would race between concurrent runs and bill the wrong account. The env is
    // only ever a FALLBACK, resolved once per adapter at construction.
    const source = readFileSync(new URL("../src/supervisor.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/process\.env\.AWS_PROFILE/);
  });
});
