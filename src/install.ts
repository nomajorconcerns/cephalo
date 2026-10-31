import fs from "node:fs";
import path from "node:path";
import { getPlatform } from "./platform.js";
import { fileURLToPath } from "node:url";
import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLMap, type YAMLSeq } from "yaml";

export type Target = "claude" | "hermes";

export function projectRoot(): string {
  // dist/install.js -> project root, forward slashes, no trailing slash
  return fileURLToPath(new URL("..", import.meta.url)).replace(/\\/g, "/").replace(/\/+$/, "");
}

export function claudeSettingsPath(): string {
  return getPlatform().claudeSettingsPath();
}

export function hermesConfigPath(): string {
  return getPlatform().hermesConfigPath();
}

// `mcp__.*` / `mcp_.*` route every MCP tool call (mcp__<server>__<tool>) to Cephalo's MCP firewall.
export const HERMES_MATCHER = "terminal|read_file|write_file|patch|search_files|execute_code|mcp_.*";
export const CLAUDE_MATCHER = "Bash|Read|Write|Edit|MultiEdit|NotebookEdit|mcp__.*";
// After-the-call hooks feed the prompt-injection tripwire: they see what came BACK from tools that read outside content.
export const HERMES_POST_MATCHER = "terminal|read_file|search_files|execute_code|web_search|web_extract|browser_.*|mcp_.*";
export const CLAUDE_POST_MATCHER = "Bash|Read|Grep|Glob|WebFetch|WebSearch|mcp__.*";
export const CLAUDE_CMD_RE = /cli\.js["']?\s+hook\s+claude\b/;
export const HERMES_CMD_RE = /cli\.js["']?\s+hook\s+hermes\b/;

export const claudeCommand = (abs: string) => `node ${abs}/dist/cli.js hook claude`;
export const hermesCommand = (abs: string) => `node ${abs}/dist/cli.js hook hermes`;

const CLAUDE_SECTIONS: Array<[string, string]> = [
  ["PreToolUse", CLAUDE_MATCHER],
  ["PostToolUse", CLAUDE_POST_MATCHER],
];
const HERMES_SECTIONS: Array<[string, string]> = [
  ["pre_tool_call", HERMES_MATCHER],
  ["post_tool_call", HERMES_POST_MATCHER],
];

function backup(file: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${file}.cephalo-backup-${stamp}`;
  fs.copyFileSync(file, dest);
  return dest;
}

const isObj = (v: unknown): v is Record<string, any> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function readClaude(file: string): Record<string, any> {
  if (!fs.existsSync(file)) return {};
  const txt = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  if (!txt.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(txt);
  } catch (e) {
    throw new Error(`${file} is not valid JSON, refusing to touch it: ${(e as Error).message}`);
  }
  if (!isObj(parsed)) throw new Error(`${file} is not a JSON object, refusing to touch it.`);
  return parsed;
}

function writeClaude(file: string, settings: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

/** Make sure `hooks.<section>` has Cephalo's entry with the right matcher. Returns what changed, or null if nothing did. */
function ensureClaudeSection(settings: Record<string, any>, section: string, matcher: string, cmd: string, file: string): string | null {
  if (settings.hooks[section] === undefined) settings.hooks[section] = [];
  const list = settings.hooks[section];
  if (!Array.isArray(list)) throw new Error(`"hooks.${section}" in ${file} is not an array.`);
  const existing = list.find((e) => Array.isArray(e?.hooks) && e.hooks.some((h: any) => h?.command === cmd));
  if (existing) {
    if (existing.matcher === matcher) return null;
    const old = existing.matcher;
    existing.matcher = matcher;
    return `Updated Cephalo matcher in hooks.${section}: "${old}" -> "${matcher}"`;
  }
  const entry = { matcher, hooks: [{ type: "command", command: cmd }] };
  list.push(entry);
  return `Added to hooks.${section}: ${JSON.stringify(entry)}`;
}

export function installClaude(file = claudeSettingsPath(), abs = projectRoot()): string[] {
  const cmd = claudeCommand(abs);
  const existed = fs.existsSync(file);
  const settings = readClaude(file);
  if (settings.hooks === undefined) settings.hooks = {};
  if (!isObj(settings.hooks)) throw new Error(`"hooks" in ${file} is not an object.`);
  const changes = CLAUDE_SECTIONS.map(([section, matcher]) => ensureClaudeSection(settings, section, matcher, cmd, file)).filter((c): c is string => c !== null);
  if (changes.length === 0) return [`Already installed in ${file}. No changes made.`];
  const out: string[] = [];
  if (existed) out.push(`Backup: ${backup(file)}`);
  else out.push(`Backup: none (${file} did not exist, creating it)`);
  writeClaude(file, settings);
  out.push(`Changed: ${file}`, ...changes);
  return out;
}

export function uninstallClaude(file = claudeSettingsPath()): string[] {
  if (!fs.existsSync(file)) return [`${file} does not exist. Nothing to remove.`];
  const settings = readClaude(file);
  if (!CLAUDE_SECTIONS.some(([section]) => Array.isArray(settings.hooks?.[section]))) return [`No hooks.PreToolUse in ${file}. Nothing to remove.`];
  const removed: string[] = [];
  for (const [section] of CLAUDE_SECTIONS) {
    const list = settings.hooks?.[section];
    if (!Array.isArray(list)) continue;
    const kept: any[] = [];
    for (const e of list) {
      if (!isObj(e) || !Array.isArray(e.hooks)) {
        kept.push(e);
        continue;
      }
      const remaining = e.hooks.filter((h: any) => {
        const hit = typeof h?.command === "string" && CLAUDE_CMD_RE.test(h.command);
        if (hit) removed.push(`Removed from hooks.${section}: ${h.command}`);
        return !hit;
      });
      if (remaining.length === e.hooks.length) kept.push(e);
      else if (remaining.length > 0) kept.push({ ...e, hooks: remaining });
    }
    if (kept.length > 0) settings.hooks[section] = kept;
    else delete settings.hooks[section];
  }
  if (removed.length === 0) return [`No Cephalo entries found in ${file}. No changes made.`];
  const out = [`Backup: ${backup(file)}`];
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeClaude(file, settings);
  out.push(`Changed: ${file}`, ...removed);
  return out;
}

function loadHermesDoc(file: string) {
  const doc = parseDocument(fs.readFileSync(file, "utf8"));
  if (doc.errors.length) throw new Error(`Cannot parse ${file}: ${doc.errors[0]!.message}`);
  if (doc.contents !== null && !isMap(doc.contents)) {
    throw new Error(`${file} top level is not a mapping, refusing to touch it.`);
  }
  return doc;
}

const isNullNode = (n: unknown) => n == null || (isScalar(n) && n.value == null);

function ensureHermesSection(doc: Document, section: string, matcher: string, cmd: string, file: string): string | null {
  if (isNullNode(doc.getIn(["hooks", section], true))) doc.setIn(["hooks", section], doc.createNode([]));
  const seq = doc.getIn(["hooks", section], true);
  if (!isSeq(seq)) throw new Error(`"hooks.${section}" in ${file} is not a list.`);
  const dup = (seq as YAMLSeq).items.find((it) => isMap(it) && it.toJSON()?.command === cmd) as YAMLMap | undefined;
  if (dup) {
    const old = dup.toJSON().matcher;
    if (old === matcher) return null;
    dup.set("matcher", doc.createNode(matcher));
    const m = dup.get("matcher", true);
    if (isScalar(m)) m.type = "QUOTE_DOUBLE";
    return `Updated Cephalo matcher in hooks.${section}: "${old}" -> "${matcher}"`;
  }
  const item = doc.createNode({ matcher, command: cmd, timeout: 10 }) as YAMLMap;
  for (const pair of item.items) {
    if (isScalar(pair.value) && typeof pair.value.value === "string") pair.value.type = "QUOTE_DOUBLE";
  }
  (seq as YAMLSeq).flow = false;
  (seq as YAMLSeq).add(item);
  return `Added to hooks.${section}: matcher "${matcher}", command "${cmd}", timeout 10`;
}

export function installHermes(file = hermesConfigPath(), abs = projectRoot()): string[] {
  if (!fs.existsSync(file)) throw new Error(`${file} does not exist. Is Hermes installed? Not creating it.`);
  const cmd = hermesCommand(abs);
  const doc = loadHermesDoc(file);
  if (isNullNode(doc.get("hooks", true))) doc.set("hooks", doc.createNode({}));
  if (!isMap(doc.get("hooks", true))) throw new Error(`"hooks" in ${file} is not a mapping.`);
  const changes = HERMES_SECTIONS.map(([section, matcher]) => ensureHermesSection(doc, section, matcher, cmd, file)).filter((c): c is string => c !== null);
  if (changes.length === 0) return [`Already installed in ${file}. No changes made.`];
  const out = [`Backup: ${backup(file)}`];
  fs.writeFileSync(file, doc.toString({ lineWidth: 0 }), "utf8");
  out.push(`Changed: ${file}`, ...changes);
  return out;
}

export function uninstallHermes(file = hermesConfigPath()): string[] {
  if (!fs.existsSync(file)) return [`${file} does not exist. Nothing to remove.`];
  const doc = loadHermesDoc(file);
  if (!HERMES_SECTIONS.some(([section]) => isSeq(doc.getIn(["hooks", section], true)))) return [`No hooks.pre_tool_call list in ${file}. Nothing to remove.`];
  const removed: string[] = [];
  for (const [section] of HERMES_SECTIONS) {
    const seq = doc.getIn(["hooks", section], true);
    if (!isSeq(seq)) continue;
    let hit = false;
    for (let i = seq.items.length - 1; i >= 0; i--) {
      const it = seq.items[i];
      const c = isMap(it) ? it.toJSON()?.command : undefined;
      if (typeof c === "string" && HERMES_CMD_RE.test(c)) {
        removed.unshift(`Removed from hooks.${section}: ${c}`);
        seq.delete(i);
        hit = true;
      }
    }
    if (hit && seq.items.length === 0) doc.deleteIn(["hooks", section]);
  }
  if (removed.length === 0) return [`No Cephalo entries found in ${file}. No changes made.`];
  const out = [`Backup: ${backup(file)}`];
  const hooks = doc.get("hooks", true);
  if (isMap(hooks) && hooks.items.length === 0) doc.delete("hooks");
  fs.writeFileSync(file, doc.toString({ lineWidth: 0 }), "utf8");
  out.push(`Changed: ${file}`, ...removed);
  return out;
}
