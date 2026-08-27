import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * a supervised harness must resolve the DEVELOPER'S tool versions.
 *
 * Measured, which is why this test exists: with the package manager's bin directory first, a project
 * pinning `node = "22"` via mise resolved `/opt/homebrew/bin/node` (v26.5.1) while the developer
 * standing in that same directory got v22.22.0. Claude would have built against a toolchain nobody
 * uses, and nothing would have said so — the command succeeds, it just runs the wrong binary.
 *
 * Both supervision units set PATH explicitly, because launchd and systemd each hand a unit a
 * near-empty one. The ORDER is the part that carries the requirement: version-manager shims ahead of
 * the package manager, which is also how `mise activate` arranges them.
 *
 * Asserted against the unit FILES rather than a running process: the property belongs to what we
 * ship, and the running harness on any given machine may have been started interactively.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");

const UNITS = [
  {
    name: "launchd (macOS)",
    path: join(ROOT, "docker/launchd/com.clawdparty.harness.plist"),
    // `HOME_PLACEHOLDER` is substituted by the documented `sed` at install time.
    home: "HOME_PLACEHOLDER",
    packageManagerBin: "/opt/homebrew/bin",
  },
  {
    name: "systemd (Linux)",
    path: join(ROOT, "docker/systemd/clawdparty-harness.service"),
    // `%h` is systemd's own expansion, available because this is a USER unit.
    home: "%h",
    packageManagerBin: "/usr/local/bin",
  },
];

/** The PATH value the unit sets, as one string. */
function pathOf(source: string): string {
  const line = source
    .split("\n")
    .find((l) => /PATH=|<string>.*shims/.test(l) && l.includes("shims"));
  return line ?? "";
}

describe.each(UNITS)("$name", ({ path, home, packageManagerBin }) => {
  const source = readFileSync(path, "utf8");
  const pathValue = pathOf(source);

  it("sets a PATH at all", () => {
    // A unit with no explicit PATH is the single most common supervised-startup failure: `node` is
    // simply not found.
    expect(pathValue).not.toBe("");
  });

  it("includes a version-manager shim directory", () => {
    expect(pathValue).toContain(`${home}/.local/share/mise/shims`);
  });

  it("puts shims BEFORE the package manager, which is the whole requirement", () => {
    const shims = pathValue.indexOf(`${home}/.local/share/mise/shims`);
    const pkg = pathValue.indexOf(packageManagerBin);

    expect(shims, "no shim directory found").toBeGreaterThanOrEqual(0);
    expect(pkg, "no package-manager bin found").toBeGreaterThanOrEqual(0);
    // The ordering IS. Reversed, a pinned project silently gets the system toolchain.
    expect(shims).toBeLessThan(pkg);
  });

  it("explains WHY the order matters, so a tidy-up does not reverse it", () => {
    // This ordering looks arbitrary and would be the first thing someone "cleaned up".
    expect(source).toMatch(/|shims come first|version-manager shims/i);
  });
});
