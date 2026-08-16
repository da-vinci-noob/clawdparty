// capabilities.ts — read-only, cwd-scoped discovery of the host's connectors
// (MCP servers) and skills, mirroring models.ts. The harness is the ONLY process
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
import { parseFrontmatter } from "./frontmatter.js";

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

// Claude Code stores MCP servers either at the top level (`mcpServers`) OR
// project-scoped under `projects[<cwd>].mcpServers`. Merge both for this cwd,
// with the project-scoped entry winning within a single file.
function serversFromConfig(config: Record<string, unknown>, cwd: string): Record<string, unknown> {
  const top = extractServers(config);
  const projects = config.projects;
  if (projects === null || typeof projects !== "object") {
    return top;
  }
  const proj = (projects as Record<string, unknown>)[cwd];
  if (proj === null || typeof proj !== "object") {
    return top;
  }
  return { ...top, ...extractServers(proj as Record<string, unknown>) };
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

// Merge the host's MCP server configs from the session repo (`<cwd>/.mcp.json`) and
// host-wide user config. Note `~/.claude.json` (where Claude Code actually stores user
// MCP servers) is a FILE beside the `~/.claude/` dir, and the harness reads it
// directly. De-dup by name with the REPO (project) source winning over user config —
// the project file is the more specific, per-repo intent. `hadSource` distinguishes
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
    for (const [name, serverConfig] of Object.entries(serversFromConfig(parsed, cwd))) {
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

/**
 * AWS named profiles the host has configured, for the Bedrock profile picker.
 *
 * NAMES ONLY. This parses section headers out of `~/.aws/config` and never opens
 * `~/.aws/credentials`, so no credential value is read here at all — the same separation
 * `providers/credentials/sources.ts` keeps between naming a place and reading it.
 *
 * Enumerated rather than free-typed so the setting is a CHOICE among what exists. A free-text
 * profile name fails at run time as an opaque AWS credential error, and the participant has no
 * way to know which names are valid.
 */
export interface AwsProfileList {
  profiles: string[];
  /** "host" when ~/.aws/config was readable, "unavailable" when there is none. */
  source: "host" | "unavailable";
}

export function listAwsProfiles(home: string = homedir()): AwsProfileList {
  const path = join(home, ".aws", "config");
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return { profiles: [], source: "unavailable" };
  }

  const profiles: string[] = [];
  for (const line of body.split("\n")) {
    // `[profile name]` in config; a bare `[default]` is the default profile. `[sso-session x]`
    // is NOT a profile — it is a shared SSO block a profile refers to, and offering it would
    // produce a credential error that names something the user did select.
    const match = /^\s*\[\s*(?:profile\s+)?([^\]]+?)\s*\]\s*$/.exec(line);
    if (!match) continue;
    const name = match[1] as string;
    if (name.startsWith("sso-session") || name.startsWith("services")) continue;
    if (!profiles.includes(name)) profiles.push(name);
  }
  return { profiles, source: "host" };
}
