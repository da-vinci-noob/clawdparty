import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BashTool } from "../../src/tools/bash.js";
import type { ToolContext } from "../../src/tools/registry.js";
import { shimDirs, toolchainEnv } from "../../src/tools/toolchain.js";

/**
 * a command Claude runs resolves what the developer's own shell
 * resolves.
 *
 * This only became testable, and only became TRUE, once the harness left the
 * container: in a container the toolchain was whatever the image had, and matching the
 * host was not possible at any configuration.
 *
 * The measured problem on a real host: `bash -lc` is a login shell, so it reads
 * profile files, but version managers are usually activated in an INTERACTIVE rc file
 * (`.zshrc`) that no non-interactive shell sources — and the developer's shell is often
 * zsh, not bash. So a version-manager-pinned project would resolve the SYSTEM tool.
 * Shim directories fix it without any shell activation, which is what they are for.
 */

let dir: string;
let home: string;
const bash = new BashTool();

function ctx(cwd: string): ToolContext {
  return { runId: "run_toolchain", cwd, signal: new AbortController().signal };
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "harness-toolchain-")));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("shim directories", () => {
  it("finds a mise shim dir when it exists", () => {
    const shims = join(home, ".local", "share", "mise", "shims");
    mkdirSync(shims, { recursive: true });

    expect(shimDirs(home)).toEqual([shims]);
  });

  it("finds asdf, rbenv and pyenv shims too, so this is not mise-specific", () => {
    for (const rel of [
      [".asdf", "shims"],
      [".rbenv", "shims"],
      [".pyenv", "shims"],
    ]) {
      mkdirSync(join(home, ...rel), { recursive: true });
    }

    expect(shimDirs(home)).toEqual([
      join(home, ".asdf", "shims"),
      join(home, ".rbenv", "shims"),
      join(home, ".pyenv", "shims"),
    ]);
  });

  it("returns nothing on a machine with no version manager", () => {
    // Must be a no-op rather than inventing paths: a bogus PATH entry is a silent
    // slowdown on every command.
    expect(shimDirs(home)).toEqual([]);
  });
});

describe("the environment a bash call runs with", () => {
  it("PREPENDS shims so a pinned version beats the system one", () => {
    const shims = join(home, ".local", "share", "mise", "shims");
    mkdirSync(shims, { recursive: true });

    const env = toolchainEnv({ PATH: "/usr/bin:/bin" }, home);

    // Appending would leave /usr/bin/node winning, and the pinned version would never
    // be reached — the whole failure this prevents.
    expect(env.PATH).toBe(`${shims}:/usr/bin:/bin`);
  });

  it("does not duplicate a shim dir already on PATH", () => {
    const shims = join(home, ".local", "share", "mise", "shims");
    mkdirSync(shims, { recursive: true });

    const env = toolchainEnv({ PATH: `${shims}:/usr/bin` }, home);

    expect(env.PATH).toBe(`${shims}:/usr/bin`);
  });

  it("leaves PATH untouched when there are no shims", () => {
    expect(toolchainEnv({ PATH: "/usr/bin:/bin" }, home).PATH).toBe("/usr/bin:/bin");
  });

  it("passes the host environment through and marks the session", () => {
    const env = toolchainEnv(
      { PATH: "/usr/bin", AWS_PROFILE: "work", SSH_AUTH_SOCK: "/tmp/agent" },
      home,
    );

    // covers git config and the SSH agent as well as tool versions, and both
    // reach a command through inherited env — SSH_AUTH_SOCK is what makes an
    // authenticated `git push` possible at all.
    expect(env.AWS_PROFILE).toBe("work");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/agent");
    expect(env.CLAWDPARTY_SESSION).toBe("1");
  });
});

describe("the shell the harness actually runs", () => {
  it("uses a LOGIN shell, so profile-configured toolchains are picked up", () => {
    const body = readFileSync(new URL("../../src/tools/bash.ts", import.meta.url), "utf8");

    // `-lc`, not `-c`. A non-login shell reads no profile at all, so a toolchain set up
    // there would be invisible. Asserted at the source because the flag is the
    // mechanism and nothing else observes it.
    expect(body).toMatch(/spawn\("bash", \["-lc", command\]/);
    expect(body).toMatch(/env: toolchainEnv\(/);
  });

  it("runs in the session cwd, which is what makes a project's pin apply", () => {
    const body = readFileSync(new URL("../../src/tools/bash.ts", import.meta.url), "utf8");

    // A shim resolves the version from the config in the CURRENT directory, so
    // spawning anywhere else would resolve the wrong project's pin.
    expect(body).toMatch(/cwd: ctx\.cwd/);
  });
});

describe("end to end against the real host shell", () => {
  it("resolves the same tool the developer's own login shell resolves", async () => {
    const viaTool = await bash.run({ command: "command -v git && git --version" }, ctx(dir));
    const viaShell = execFileSync("bash", ["-lc", "command -v git && git --version"], {
      cwd: dir,
      encoding: "utf8",
    });

    // Compares against the developer's shell rather than a hardcoded version, which is
    // the actual  property ("behaves as it would if the developer ran it") and
    // does not rot when the host upgrades.
    expect(viaTool.isError).toBe(false);
    expect(viaTool.content[0]?.text).toContain(viaShell.trim().split("\n")[0]);
  });

  it("sees the session cwd, not the harness process cwd", async () => {
    const result = await bash.run({ command: "pwd" }, ctx(dir));

    expect(result.content[0]?.text).toContain(dir);
  });

  it("inherits the host PATH rather than a minimal one", async () => {
    const result = await bash.run({ command: 'echo "$PATH"' }, ctx(dir));

    // A spawn with `env: {}` would produce a PATH with none of the host's entries, and
    // every version-manager binary would vanish.
    expect(result.content[0]?.text).toContain("/usr/bin");
  });
});
