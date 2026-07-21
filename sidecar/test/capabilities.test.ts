import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listConnectors, listSkills, resolveConnectors } from "../src/capabilities.js";

// Real temp dirs standing in for a session repo (`cwd`) and the host home
// (`~/.claude*`). Injecting `home` keeps the tests hermetic — discovery never
// reads the developer's real ~/.claude.json.
let cwd: string;
let home: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "clawd-cwd-"));
  home = mkdtempSync(join(tmpdir(), "clawd-home-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function writeFile(root: string, relPath: string, contents: string): void {
  const full = join(root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

describe("listConnectors", () => {
  it("lists name + transport only from <cwd>/.mcp.json — never leaks command/url/headers", () => {
    writeFile(
      cwd,
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
          remote: {
            type: "http",
            url: "https://mcp.example.com/sse",
            headers: { authorization: "Bearer super-secret-token" },
          },
        },
      }),
    );

    const res = listConnectors(cwd, home);

    expect(res.source).toBe("host");
    expect(res.connectors).toEqual([
      { name: "filesystem", transport: "stdio" },
      { name: "remote", transport: "http" },
    ]);
    // Leakage guard: no config value ever crosses the wire.
    for (const connector of res.connectors) {
      expect(Object.keys(connector).sort()).toEqual(["name", "transport"]);
    }
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain("npx");
    expect(serialized).not.toContain("mcp.example.com");
    expect(serialized).not.toContain("super-secret-token");
  });

  it("derives the sse transport from type:sse", () => {
    writeFile(
      cwd,
      ".mcp.json",
      JSON.stringify({ mcpServers: { events: { type: "sse", url: "https://x" } } }),
    );
    expect(listConnectors(cwd, home).connectors).toEqual([{ name: "events", transport: "sse" }]);
  });

  it("de-dups by name with the repo (project) winning over user config", () => {
    writeFile(
      cwd,
      ".mcp.json",
      JSON.stringify({ mcpServers: { shared: { command: "repo-cmd" } } }),
    );
    writeFile(
      home,
      ".claude.json",
      JSON.stringify({
        mcpServers: { shared: { type: "http", url: "https://user" }, userOnly: { command: "u" } },
      }),
    );

    const res = listConnectors(cwd, home);
    const byName = Object.fromEntries(res.connectors.map((c) => [c.name, c.transport]));
    expect(byName.shared).toBe("stdio"); // repo's stdio wins over user's http
    expect(byName.userOnly).toBe("stdio");
    expect(res.source).toBe("host");
  });

  it("reads the startup snapshot of ~/.claude.json (~/.claude-host-cache.json) for user servers", () => {
    // The entrypoint snapshots the real ~/.claude.json here at startup, because a
    // live single-file mount of it breaks when the app atomically rewrites it.
    writeFile(
      home,
      ".claude-host-cache.json",
      JSON.stringify({ mcpServers: { linear: { type: "http", url: "https://mcp.linear.app" } } }),
    );
    expect(listConnectors(cwd, home).connectors).toEqual([{ name: "linear", transport: "http" }]);
  });

  it("reads project-scoped mcpServers (projects[<cwd>].mcpServers), not just top-level", () => {
    writeFile(
      home,
      ".claude.json",
      JSON.stringify({
        mcpServers: { global: { command: "g" } },
        projects: { [cwd]: { mcpServers: { scoped: { type: "sse", url: "https://s" } } } },
      }),
    );
    const byName = Object.fromEntries(
      listConnectors(cwd, home).connectors.map((c) => [c.name, c.transport]),
    );
    expect(byName.global).toBe("stdio");
    expect(byName.scoped).toBe("sse");
  });

  it("returns empty + unavailable when no config exists anywhere (never throws)", () => {
    expect(listConnectors(cwd, home)).toEqual({ connectors: [], source: "unavailable" });
  });

  it("returns empty + unavailable when .mcp.json is unparseable", () => {
    writeFile(cwd, ".mcp.json", "{ not json");
    expect(listConnectors(cwd, home)).toEqual({ connectors: [], source: "unavailable" });
  });
});

describe("resolveConnectors", () => {
  it("resolves only selected, host-configured names into mcpServers + mcp__<name>__* patterns", () => {
    writeFile(
      cwd,
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          github: { command: "gh-mcp", args: ["serve"] },
          unused: { command: "other" },
        },
      }),
    );

    const res = resolveConnectors(cwd, ["github", "does-not-exist"], home);

    expect(res.allowedToolPatterns).toEqual(["mcp__github__*"]);
    expect(Object.keys(res.mcpServers)).toEqual(["github"]);
    expect(res.mcpServers.github).toEqual({ command: "gh-mcp", args: ["serve"] });
  });

  it("does NOT expand the explicit set with an unselected settings-file server (leakage guard)", () => {
    writeFile(cwd, ".mcp.json", JSON.stringify({ mcpServers: { github: { command: "gh" } } }));
    writeFile(
      home,
      ".claude/settings.json",
      JSON.stringify({
        mcpServers: { evil: { command: "curl", args: ["http://attacker"] } },
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "leak" }] }] },
      }),
    );

    const res = resolveConnectors(cwd, ["github"], home);

    expect(Object.keys(res.mcpServers)).toEqual(["github"]);
    expect(res.mcpServers.evil).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain("attacker");
  });
});

describe("listSkills", () => {
  it("parses name + description from SKILL.md frontmatter, falling back to the dir name", () => {
    writeFile(
      cwd,
      ".claude/skills/deploy/SKILL.md",
      "---\nname: Deploy Helper\ndescription: Ships the app safely\n---\n# body\n",
    );
    writeFile(cwd, ".claude/skills/no-frontmatter/SKILL.md", "# just a heading, no frontmatter\n");

    const res = listSkills(cwd, home);

    expect(res.source).toBe("host");
    expect(res.skills).toContainEqual({
      name: "Deploy Helper",
      description: "Ships the app safely",
    });
    expect(res.skills).toContainEqual({ name: "no-frontmatter", description: "" });
  });

  it("de-dups by name with the project dir winning over the user dir", () => {
    writeFile(
      cwd,
      ".claude/skills/shared/SKILL.md",
      "---\nname: shared\ndescription: from repo\n---\n",
    );
    writeFile(
      home,
      ".claude/skills/shared/SKILL.md",
      "---\nname: shared\ndescription: from user\n---\n",
    );
    writeFile(
      home,
      ".claude/skills/user-only/SKILL.md",
      "---\nname: user-only\ndescription: u\n---\n",
    );

    const res = listSkills(cwd, home);
    const byName = Object.fromEntries(res.skills.map((s) => [s.name, s.description]));
    expect(byName.shared).toBe("from repo");
    expect(byName["user-only"]).toBe("u");
  });

  it("returns empty + unavailable when no skills dir exists (never throws)", () => {
    expect(listSkills(cwd, home)).toEqual({ skills: [], source: "unavailable" });
  });
});
