import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, parseDocument, Scalar, YAMLMap, YAMLSeq } from "yaml";
import { getPlatform } from "../platform.js";
import { globToRegExp, isMatchAll, normalizeCommandString, normalizeUrl, type ServerDef, identityOf } from "./identity.js";

export type McpMode = "audit" | "enforce";

export interface AllowEntry {
  /** Command line the server runs. `*` matches anything. Matched after normalizing the executable. */
  command?: string;
  /** Server URL. `*` matches anything. Scheme/host case, default port, query and trailing slash are ignored. */
  url?: string;
  /** Free text for humans. NEVER used for matching. */
  label?: string;
  added?: string;
}

export interface McpPolicy {
  mode: McpMode;
  allow: AllowEntry[];
}

export function mcpPolicyPath(): string {
  return path.join(getPlatform().dataDir(), "mcp.yml");
}

export const EMPTY_POLICY: McpPolicy = { mode: "audit", allow: [] };

const HEADER =
  "# Cephalo MCP allowlist.\n" +
  "# mode: audit (log only) | enforce (block MCP tool calls from servers not listed below)\n" +
  "# Servers are matched by what they RUN (command) or WHERE they are (url), never by the name in a config file.\n" +
  "# `*` matches any text. `label` is only a note for you.\n";

/** Parse mcp.yml text. Bad entries are reported and skipped (never silently widened). */
export function parseMcpPolicy(text: string): { policy: McpPolicy; problems: string[] } {
  const problems: string[] = [];
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    return { policy: { ...EMPTY_POLICY }, problems: [`mcp.yml is not valid YAML: ${(e as Error).message}`] };
  }
  const o = (doc ?? {}) as Record<string, unknown>;
  let mode: McpMode = "audit";
  if (o.mode === "enforce" || o.mode === "audit") mode = o.mode;
  else if (o.mode !== undefined) problems.push(`mode must be "audit" or "enforce", got ${JSON.stringify(o.mode)}; using audit`);
  const allow: AllowEntry[] = [];
  if (o.allow !== undefined && !Array.isArray(o.allow)) problems.push("allow must be a list");
  for (const [i, raw] of (Array.isArray(o.allow) ? o.allow : []).entries()) {
    const e = (raw ?? {}) as Record<string, unknown>;
    const where = `allow[${i}]`;
    if (typeof raw !== "object" || raw === null) { problems.push(`${where}: expected a mapping`); continue; }
    if ("name" in e) { problems.push(`${where}: matching by name is not supported (use command or url; name can be put in label)`); continue; }
    const hasCmd = typeof e.command === "string" && e.command.trim() !== "";
    const hasUrl = typeof e.url === "string" && e.url.trim() !== "";
    if (hasCmd === hasUrl) { problems.push(`${where}: give exactly one of command or url`); continue; }
    const pattern = (hasCmd ? e.command : e.url) as string;
    if (isMatchAll(pattern)) { problems.push(`${where}: "${pattern}" would allow every server; skipped`); continue; }
    allow.push({
      ...(hasCmd ? { command: pattern } : { url: pattern }),
      ...(typeof e.label === "string" ? { label: e.label } : {}),
      ...(typeof e.added === "string" ? { added: e.added } : {}),
    });
  }
  return { policy: { mode, allow }, problems };
}

/** Missing file means audit mode with an empty list: log everything, block nothing. */
export function loadMcpPolicy(file: string = mcpPolicyPath()): McpPolicy {
  if (!fs.existsSync(file)) return { ...EMPTY_POLICY, allow: [] };
  const { policy, problems } = parseMcpPolicy(fs.readFileSync(file, "utf8"));
  for (const p of problems) process.stderr.write(`cephalo: ${p}\n`);
  return policy;
}

/** The allowlist entry that permits this server, if any. */
export function matchAllow(policy: McpPolicy, def: ServerDef): AllowEntry | undefined {
  if (def.kind === "http") {
    const url = normalizeUrl(def.url ?? "");
    return policy.allow.find((e) => e.url !== undefined && globToRegExp(normalizeUrl(e.url).replace(/\/$/, ""), "i").test(url));
  }
  const line = identityOf(def).slice(4); // strip "cmd:"
  return policy.allow.find((e) => e.command !== undefined && globToRegExp(normalizeCommandString(e.command)).test(line));
}

function backup(file: string): string {
  const dest = `${file}.cephalo-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(file, dest);
  return dest;
}

/** Load the file as a YAML Document (comments preserved), or start a fresh one. */
function openDoc(file: string) {
  if (fs.existsSync(file)) {
    const doc = parseDocument(fs.readFileSync(file, "utf8"));
    if (doc.errors.length) throw new Error(`${file} is not valid YAML, refusing to touch it: ${doc.errors[0].message}`);
    if (doc.contents === null) doc.contents = new YAMLMap() as any;
    return doc;
  }
  return parseDocument("mode: audit\nallow: []\n");
}

function save(file: string, doc: ReturnType<typeof openDoc>): string | null {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let bak: string | null = null;
  if (fs.existsSync(file)) bak = backup(file);
  const body = doc.toString({ lineWidth: 0 });
  fs.writeFileSync(file, fs.existsSync(file) && bak ? body : HEADER + body, "utf8");
  return bak;
}

/** Add an allowlist entry (idempotent on the same command/url). Returns what happened. */
export function addAllowEntry(entry: { command?: string; url?: string; label?: string }, file: string = mcpPolicyPath()): { added: boolean; backup: string | null } {
  const doc = openDoc(file);
  let seq = doc.get("allow") as YAMLSeq | undefined;
  if (!seq || !(seq instanceof YAMLSeq)) {
    seq = new YAMLSeq();
    doc.set("allow", seq);
  }
  seq.flow = false;
  const key = entry.command !== undefined ? "command" : "url";
  const val = (entry.command ?? entry.url) as string;
  const norm = (s: string) => (key === "command" ? normalizeCommandString(s) : normalizeUrl(s));
  for (const item of seq.items) {
    if (item instanceof YAMLMap) {
      const existing = item.get(key);
      if (typeof existing === "string" && norm(existing) === norm(val)) return { added: false, backup: null };
    }
  }
  const map = new YAMLMap();
  const s = new Scalar(val);
  s.type = Scalar.QUOTE_DOUBLE;
  map.set(key, s);
  if (entry.label) map.set("label", entry.label);
  map.set("added", new Date().toISOString());
  seq.add(map);
  return { added: true, backup: save(file, doc) };
}

export function setMcpMode(mode: McpMode, file: string = mcpPolicyPath()): { changed: boolean; backup: string | null } {
  const doc = openDoc(file);
  if (doc.get("mode") === mode) return { changed: false, backup: null };
  doc.set("mode", mode);
  return { changed: true, backup: save(file, doc) };
}
