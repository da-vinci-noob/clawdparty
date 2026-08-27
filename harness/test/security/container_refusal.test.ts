import { describe, expect, it } from "vitest";
import { containerMarkers } from "../../src/index.js";

/**
 * the harness refuses to start inside a container.
 *
 * Not a style preference. In a container, credential discovery reads host paths that
 * are not there (, and on macOS the Keychain is unreachable at ANY mount
 * configuration), the store lands in a layer that vanishes on restart, and a `cwd`
 * from a run-start payload is a host path that may not resolve. Every one of those
 * fails later and somewhere else, so the useful failure is the one at boot.
 */

function probe(files: Record<string, string>) {
  return {
    exists: (p: string) => p in files,
    read: (p: string) => files[p] ?? "",
  };
}

describe("container detection", () => {
  it("finds nothing on a plain host", () => {
    expect(containerMarkers(probe({ "/proc/self/cgroup": "0::/" }))).toEqual([]);
  });

  it("detects /.dockerenv", () => {
    const markers = containerMarkers(probe({ "/.dockerenv": "" }));

    expect(markers).toContain("/.dockerenv exists");
  });

  it("detects a container runtime in the cgroup path", () => {
    const markers = containerMarkers(probe({ "/proc/self/cgroup": "0::/docker/3b2c1a\n" }));

    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatch(/cgroup/);
  });

  for (const runtime of ["containerd", "kubepods", "libpod"]) {
    it(`detects ${runtime}`, () => {
      const markers = containerMarkers(probe({ "/proc/self/cgroup": `0::/${runtime}/abc` }));

      expect(markers).toHaveLength(1);
    });
  }

  it("reports BOTH markers when both are present, so the message names them", () => {
    const markers = containerMarkers(
      probe({ "/.dockerenv": "", "/proc/self/cgroup": "0::/docker/abc" }),
    );

    expect(markers).toHaveLength(2);
  });

  it("does not mistake a cgroup v2 host line for a container", () => {
    // A modern non-container Linux host reports exactly `0::/`. Matching too loosely
    // here would make the harness refuse to start on a normal Linux laptop, which is
    // a worse failure than the one being prevented.
    expect(containerMarkers(probe({ "/proc/self/cgroup": "0::/" }))).toEqual([]);
    expect(
      containerMarkers(probe({ "/proc/self/cgroup": "0::/user.slice/user-501.slice" })),
    ).toEqual([]);
  });

  it("treats an unreadable /proc/self/cgroup as absent, not as a container", () => {
    // macOS has no /proc at all. Reading it must not be what decides the answer.
    expect(containerMarkers(probe({}))).toEqual([]);
  });
});
