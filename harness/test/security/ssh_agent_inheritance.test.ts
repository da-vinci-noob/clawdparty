import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Claude's `git push` authenticates with the DEVELOPER'S ssh agent, and the
 * harness was handing it the wrong one.
 *
 * An earlier investigation concluded the 1Password agent "refuses to sign", needed interactive
 * approval, and was NOT a harness defect. Measured with the agent unlocked, that was wrong on every
 * count. The running harness had `SSH_AUTH_SOCK=/var/run/com.apple.launchd.<id>/Listeners` — Apple's
 * agent, which holds no identities — while the developer's real agent at
 * `~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock` held four keys including two
 * for GitHub. `ssh-add -l` reporting "no identities" was the wrong agent answering, not a locked one.
 *
 * It is the same class as the supervised-PATH finding: `bin/harness` inherits the launching shell's
 * environment, and a non-interactive shell never sources `.zshrc`, where the agent export lives.
 * Under launchd it is worse — an agent gets a near-empty environment, so there is no socket at all
 * unless something names one.
 *
 * Proven end to end once the socket was right, through a real harness `bash` call:
 * `ssh -T git@github.com` answered "Hi shah0x01! You've successfully authenticated".
 *
 * The fix is `.env.local`, which `bin/harness` sources with `set -a` before exec — so ONE place
 * serves both the interactive and the supervised path, and neither unit needs a vendor's socket
 * baked into it. These assertions pin that mechanism, because the failure it prevents surfaces as
 * `Permission denied (publickey)` from inside a tool call, which is a long way from its cause.
 */

const root = fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string): string => readFileSync(`${root}/${path}`, "utf8");

const HARNESS = read("bin/harness");
const PLIST = read("docker/launchd/com.clawdparty.harness.plist");
const SERVICE = read("docker/systemd/clawdparty-harness.service");
const ENV_EXAMPLE = read(".env.example");

describe("the developer's agent reaches Claude's shell", () => {
  it("exports every .env.local assignment, which is what carries the socket", () => {
    // `set -a` before the source is the whole mechanism: without it the value is a shell variable
    // the exec'd process never sees.
    expect(HARNESS).toMatch(/set -a[\s\S]{0,200}source "\$\{env_local\}"/);
  });

  it("lets .env.local OVERRIDE an inherited socket, not merely fill an empty one", () => {
    // The broken case had SSH_AUTH_SOCK already set — to the wrong agent. A `:-` default would have
    // kept it. Sourcing after the inherit is what makes the file authoritative.
    expect(HARNESS).not.toMatch(/SSH_AUTH_SOCK="?\$\{SSH_AUTH_SOCK:-/);
  });

  it("documents the setting where a developer configures the harness", () => {
    expect(ENV_EXAMPLE).toMatch(/SSH_AUTH_SOCK/);
    // The reason, not just the key: a bare key gets deleted by the next person tidying up.
    expect(ENV_EXAMPLE).toMatch(/agent/i);
  });

  it("QUOTES the example path, because the normal one contains a space", () => {
    // `bin/harness` sources this file. An unquoted path with a space is split by the shell, which
    // runs the tail as a command and leaves SSH_AUTH_SOCK at whatever was INHERITED — silently, so
    // it reads as configured while still pointing at the wrong agent. The first version of this
    // documentation was unquoted and did exactly that: `bin/harness start` came back STOPPED, and
    // the value stayed on Apple's empty agent. 1Password's macOS path has a space, so this is the
    // normal case.
    const example = ENV_EXAMPLE.split("\n").find(
      (line) => line.includes("SSH_AUTH_SOCK=") && line.includes("agent.sock"),
    );
    expect(example).toBeDefined();
    expect(example).toMatch(/SSH_AUTH_SOCK="/);
  });
});

describe("neither supervision unit hardcodes a vendor's agent", () => {
  for (const [name, unit] of [
    ["launchd plist", PLIST],
    ["systemd service", SERVICE],
  ] as const) {
    it(`${name} names no specific agent socket`, () => {
      // 1Password's path is this host's answer, not the project's. Baking it in would break every
      // developer using ssh-agent, gpg-agent, Secretive or a Yubikey.
      expect(unit).not.toMatch(/1password|2BUA8C4S2C|gpg-agent/i);
    });

    it(`${name} runs bin/harness, so it inherits the .env.local route`, () => {
      expect(unit).toMatch(/bin\/harness/);
    });
  }
});
