// capabilities.ts — read-only, cwd-scoped discovery of the host's connectors
// (MCP servers) and skills, mirroring models.ts. The sidecar is the ONLY process
// that reads host config; discovery reflects only what the host already configured
// (a browser user can enable/disable but never define a capability). Every function
// is defensive: a missing/unparseable source yields an empty list tagged
// "unavailable" — it NEVER throws, exactly like listModels() degrades to fallback.
//
// SAFETY: connector listings expose ONLY name + transport — never the server's
// command/args/url/headers/env/tokens. resolveConnectors() (which DOES read the
// full config) is used only to build the SDK mcpServers for names the run
// explicitly selected; unknown names are skipped, and a client can never supply a
// raw config (it sends names only).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConnectorInfo, SkillInfo } from "@clawdparty/contracts";

export interface ConnectorList {
  connectors: ConnectorInfo[];
  // "host" when at least one config source was readable; "unavailable" otherwise.
  source: string;
}

export interface SkillList {
  skills: SkillInfo[];
  source: string;
}

export interface ResolvedConnectors {
  // SDK mcpServers entries for the selected, host-configured names (full config).
  mcpServers: Record<string, unknown>;
  // The `mcp__<name>__*` patterns to append to allowedTools (trailing * required).
  allowedToolPatterns: string[];
}

const MCP_JSON = ".mcp.json";
const SKILL_FILE = "SKILL.md";

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function extractServers(config: Record<string, unknown>): Record<string, unknown> {
  const servers = config.mcpServers;
  return servers !== null && typeof servers === "object"
    ? (servers as Record<string, unknown>)
    : {};
}

// stdio has `command`; remote transports carry `type: "http" | "sse"`. A bare
// `url` (no explicit type) is treated as http. Anything else is "unknown" — we
// still list the server (it is real, host-configured) but never leak its config.
function deriveTransport(serverConfig: unknown): string {
  const cfg = (serverConfig ?? {}) as Record<string, unknown>;
  if (typeof cfg.command === "string") {
    return "stdio";
  }
  if (cfg.type === "http" || cfg.type === "sse") {
    return cfg.type;
  }
  if (typeof cfg.url === "string") {
    return "http";
  }
  return "unknown";
}

// Merge the host's MCP server configs from the session repo (`<cwd>/.mcp.json`)
// and host-wide user config (`~/.claude.json`, `~/.claude/settings.json`).
// De-dup by name with the REPO (project) source winning over user config — the
// project file is the more specific, per-repo intent. `hadSource` distinguishes
// "no config anywhere" (→ unavailable) from "config present but empty".
function collectServerConfigs(
  cwd: string,
  home: string,
): { configs: Map<string, unknown>; hadSource: boolean } {
  const files = [
    join(cwd, MCP_JSON),
    join(home, ".claude.json"),
    join(home, ".claude", "settings.json"),
  ];
  const configs = new Map<string, unknown>();
  let hadSource = false;
  for (const file of files) {
    const parsed = readJsonFile(file);
    if (!parsed) {
      continue;
    }
    hadSource = true;
    for (const [name, serverConfig] of Object.entries(extractServers(parsed))) {
      if (!configs.has(name)) {
        configs.set(name, serverConfig); // first (project) wins
      }
    }
  }
  return { configs, hadSource };
}

// List the host-configured MCP servers for a session's repo — name + transport
// ONLY. Missing/unparseable config → empty + "unavailable"; never throws.
export function listConnectors(cwd: string, home: string = homedir()): ConnectorList {
  const { configs, hadSource } = collectServerConfigs(cwd, home);
  if (!hadSource) {
    return { connectors: [], source: "unavailable" };
  }
  const connectors = [...configs.entries()].map(([name, serverConfig]) => ({
    name,
    transport: deriveTransport(serverConfig),
  }));
  return { connectors, source: "host" };
}

// Resolve selected connector NAMES against host config into SDK mcpServers +
// `mcp__<name>__*` allow patterns. Unknown names are silently skipped — a client
// can only enable what the host already configured, never define a new server.
export function resolveConnectors(
  cwd: string,
  names: string[],
  home: string = homedir(),
): ResolvedConnectors {
  const { configs } = collectServerConfigs(cwd, home);
  const mcpServers: Record<string, unknown> = {};
  const allowedToolPatterns: string[] = [];
  for (const name of names) {
    const serverConfig = configs.get(name);
    if (serverConfig === undefined) {
      continue; // unknown → skip defensively
    }
    mcpServers[name] = serverConfig;
    allowedToolPatterns.push(`mcp__${name}__*`);
  }
  return { mcpServers, allowedToolPatterns };
}

// Parse the leading `---`…`---` YAML frontmatter for simple `key: value` pairs.
// Minimal by design (no YAML dep) — we only need `name` + `description`.
function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith("---")) {
    return {};
  }
  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of content.slice(3, end).split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match?.[1]) {
      continue;
    }
    let value = (match[2] ?? "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

// Scan one `.claude/skills` dir for `<skill>/SKILL.md`, parsing frontmatter.
// `readable` is false only when the directory itself cannot be read (missing).
function scanSkillsDir(dir: string): { skills: SkillInfo[]; readable: boolean } {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { skills: [], readable: false };
  }
  const skills: SkillInfo[] = [];
  for (const entry of entries) {
    let content: string;
    try {
      if (!statSync(join(dir, entry)).isDirectory()) {
        continue;
      }
      content = readFileSync(join(dir, entry, SKILL_FILE), "utf8");
    } catch {
      continue; // no SKILL.md in this entry
    }
    const fm = parseFrontmatter(content);
    skills.push({
      name: fm.name && fm.name.length > 0 ? fm.name : entry,
      description: fm.description ?? "",
    });
  }
  return { skills, readable: true };
}

// List skills discovered under `<cwd>/.claude/skills` + `~/.claude/skills`,
// de-duped by name with the project dir winning. Missing dirs → empty +
// "unavailable"; never throws.
export function listSkills(cwd: string, home: string = homedir()): SkillList {
  const dirs = [join(cwd, ".claude", "skills"), join(home, ".claude", "skills")];
  const byName = new Map<string, SkillInfo>();
  let readable = false;
  for (const dir of dirs) {
    const res = scanSkillsDir(dir);
    readable = readable || res.readable;
    for (const skill of res.skills) {
      if (!byName.has(skill.name)) {
        byName.set(skill.name, skill); // first (project) wins
      }
    }
  }
  if (!readable) {
    return { skills: [], source: "unavailable" };
  }
  return { skills: [...byName.values()], source: "host" };
}
