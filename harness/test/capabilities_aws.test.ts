import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAwsProfiles } from "../src/capabilities.js";

/**
 * AWS profile enumeration for the Bedrock profile setting.
 *
 * Names only. `~/.aws/credentials` is never opened, which is the same separation
 * `providers/credentials/sources.ts` keeps between naming a place and reading it  —
 * and the reason a profile list is safe to serve to the web at all.
 */

let home: string;

function writeConfig(body: string): void {
  mkdirSync(join(home, ".aws"), { recursive: true });
  writeFileSync(join(home, ".aws", "config"), body);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "harness-awsprofiles-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("listAwsProfiles", () => {
  it("reads both `[default]` and `[profile name]` forms", () => {
    writeConfig("[default]\nregion = us-east-1\n\n[profile claude-code-sso]\nregion = us-east-1\n");

    expect(listAwsProfiles(home)).toEqual({
      profiles: ["default", "claude-code-sso"],
      source: "host",
    });
  });

  it("EXCLUDES sso-session blocks, which are not profiles", () => {
    writeConfig(
      "[sso-session corp]\nsso_start_url = https://example.awsapps.com/start\n\n" +
        "[profile claude-code-sso]\nsso_session = corp\n",
    );

    // An `[sso-session]` block is a shared config a profile REFERS to. Offering it as a
    // choice would produce a credential error naming something the user did select, which is
    // the most confusing kind.
    expect(listAwsProfiles(home).profiles).toEqual(["claude-code-sso"]);
  });

  it("reports `unavailable` rather than throwing when there is no config", () => {
    // Same contract as the connector and skill listings: a missing source is an empty list
    // with a reason, never a 500 that takes the settings page down.
    expect(listAwsProfiles(home)).toEqual({ profiles: [], source: "unavailable" });
  });

  it("never reads ~/.aws/credentials", () => {
    mkdirSync(join(home, ".aws"), { recursive: true });
    writeFileSync(join(home, ".aws", "credentials"), "[default]\naws_secret_access_key = CANARY\n");
    writeConfig("[profile only-in-config]\nregion = us-east-1\n");

    // The credentials file holds values; the config file holds names. This function must only
    // ever touch the latter, and the canary proves the boundary rather than asserting it.
    const listed = listAwsProfiles(home);
    expect(JSON.stringify(listed)).not.toContain("CANARY");
    expect(listed.profiles).toEqual(["only-in-config"]);
  });

  it("de-duplicates a name that appears twice", () => {
    writeConfig("[profile dup]\nregion = us-east-1\n\n[profile dup]\nregion = eu-west-1\n");

    expect(listAwsProfiles(home).profiles).toEqual(["dup"]);
  });
});
