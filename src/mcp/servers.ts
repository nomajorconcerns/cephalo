import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { defFromRaw, identityOf, type ServerDef } from "./identity.js";
import { hermesConfigPath } from "../install.js";

export type ServerSource = "claude-local" | "claude-project" | "claude-user" | "hermes";

export interface ConfiguredServer {
  name: string;
  source: ServerSource;
  /** The file the definition was read from. */
  origin: string;
  def: ServerDef;
  identity: string;
}

export interface ServerLookup {
  home?: string;
  cwd?: string;
  hermesFile?: string;
}

const readJson = (file: string): Record<string, any> | null => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
};

/** Is `child` the same directory as `parent`, or inside it? (Claude keys local-scope servers by the project root.) */
const isWithin = (child: string, parent: string) => {
  const n = (p: string) => {
    const s = path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" || process.platform === "darwin" ? s.toLowerCase() : s;
  };
  const c = n(child);
  const p = n(parent);
  return c === p || c.startsWith(`${p}/`);
};

function fromMap(map: unknown, source: ServerSource, origin: string): ConfiguredServer[] {
  const out: ConfiguredServer[] = [];
  if (typeof map !== "object" || map === null) return out;
  for (const [name, raw] of Object.entries(map as Record<string, unknown>)) {
    const def = defFromRaw(raw);
    if (def) out.push({ name, source, origin, def, identity: identityOf(def) });
  }
  return out;
}

/** Nearest .mcp.json from `cwd` upward (stops at the filesystem root). */
function findProjectMcp(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 40; i++) {
    const f = path.join(dir, ".mcp.json");
    if (fs.existsSync(f)) return f;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * Claude Code servers visible from `cwd`, highest precedence first (local > project > user,
 * the order Claude Code itself uses when the same name is defined twice).
 */
export function listClaudeServers(o: ServerLookup = {}): ConfiguredServer[] {
  const home = o.home ?? os.homedir();
  const cwd = o.cwd ?? process.cwd();
  const out: ConfiguredServer[] = [];
  const cj = path.join(home, ".claude.json");
  const j = readJson(cj);
  if (j?.projects && typeof j.projects === "object") {
    // nearest enclosing project first
    const hits = Object.entries(j.projects as Record<string, any>)
      .filter(([proj]) => isWithin(cwd, proj))
      .sort((a, b) => b[0].length - a[0].length);
    for (const [, v] of hits) out.push(...fromMap(v?.mcpServers, "claude-local", cj));
  }
  const pm = findProjectMcp(cwd);
  if (pm) out.push(...fromMap(readJson(pm)?.mcpServers, "claude-project", pm));
  if (j) out.push(...fromMap(j.mcpServers, "claude-user", cj));
  return out;
}

export function listHermesServers(o: ServerLookup = {}): ConfiguredServer[] {
  const file = o.hermesFile ?? hermesConfigPath();
  try {
    const doc = parseYaml(fs.readFileSync(file, "utf8")) as { mcp_servers?: unknown } | null;
    const map = doc?.mcp_servers;
    if (typeof map !== "object" || map === null) return [];
    const out: ConfiguredServer[] = [];
    for (const [name, raw] of Object.entries(map as Record<string, any>)) {
      if (raw && raw.enabled === false) continue;
      const def = defFromRaw(raw);
      if (def) out.push({ name, source: "hermes", origin: file, def, identity: identityOf(def) });
    }
    return out;
  } catch {
    return [];
  }
}

/** Every server either agent can see from here (used by `cephalo mcp list`). */
export function listAllServers(o: ServerLookup = {}): ConfiguredServer[] {
  return [...listClaudeServers(o), ...listHermesServers(o)];
}

/** Hermes and Claude replace every non letter/digit/underscore in a server name with `_` inside tool names. */
export const sanitizeName = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_");

export interface ParsedMcpTool {
  /** Server segment exactly as it appears in the tool name (already sanitized). */
  server: string;
  tool: string;
  /** `mcp__plugin_<plugin>_<server>__tool`: bundled with a Claude plugin, no entry in mcpServers. */
  plugin: boolean;
}

/**
 * `mcp__<server>__<tool>` (Claude Code, and Hermes per its reference docs) or the older
 * `mcp_<server>_<tool>` (some Hermes builds). The single-underscore form is ambiguous on its own,
 * so it is resolved against the server names we actually know about (longest match wins).
 */
export function parseMcpToolName(toolName: string, knownNames: string[] = []): ParsedMcpTool | null {
  if (toolName.startsWith("mcp__")) {
    const rest = toolName.slice(5);
    const i = rest.indexOf("__");
    if (i <= 0) return null;
    const server = rest.slice(0, i);
    return { server, tool: rest.slice(i + 2), plugin: server.startsWith("plugin_") };
  }
  if (toolName.startsWith("mcp_")) {
    const rest = toolName.slice(4);
    const sorted = [...knownNames].map(sanitizeName).sort((a, b) => b.length - a.length);
    for (const s of sorted) {
      if (rest.startsWith(`${s}_`)) return { server: s, tool: rest.slice(s.length + 1), plugin: false };
    }
    const i = rest.indexOf("_");
    if (i > 0) return { server: rest.slice(0, i), tool: rest.slice(i + 1), plugin: false };
  }
  return null;
}

export const isMcpToolName = (toolName: string) => toolName.startsWith("mcp_");

/** All configured servers a parsed tool name could refer to (same name at several scopes, or names that collide once sanitized). */
export function candidatesFor(parsed: ParsedMcpTool, servers: ConfiguredServer[]): ConfiguredServer[] {
  const exact = servers.filter((s) => s.name === parsed.server);
  const pool = exact.length ? exact : servers.filter((s) => sanitizeName(s.name) === parsed.server);
  // Same name at several Claude scopes: only the highest-precedence one is live.
  const seen = new Set<string>();
  return pool.filter((s) => {
    const key = `${s.source.startsWith("claude") ? "claude" : s.source}:${s.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
