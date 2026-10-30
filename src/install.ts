import fs from "node:fs";
import path from "node:path";
import { getPlatform } from "./platform.js";
import { fileURLToPath } from "node:url";
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from "yaml";

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

export const HERMES_MATCHER = "terminal|read_file|write_file|patch|search_files|execute_code";
export const CLAUDE_MATCHER = "Bash|Read|Write|Edit|MultiEdit|NotebookEdit";
export const CLAUDE_CMD_RE = /cli\.js["']?\s+hook\s+claude\b/;
export const HERMES_CMD_RE = /cli\.js["']?\s+hook\s+hermes\b/;

export const claudeCommand = (abs: string) => `node ${abs}/dist/cli.js hook claude`;
export const hermesCommand = (abs: string) => `node ${abs}/dist/cli.js hook hermes`;

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

export function installClaude(file = claudeSettingsPath(), abs = projectRoot()): string[] {
  const cmd = claudeCommand(abs);
  const existed = fs.existsSync(file);
  const settings = readClaude(file);
  if (settings.hooks === undefined) settings.hooks = {};
  if (!isObj(settings.hooks)) throw new Error(`"hooks" in ${file} is not an object.`);
  if (settings.hooks.PreToolUse === undefined) settings.hooks.PreToolUse = [];
  const pre = settings.hooks.PreToolUse;
  if (!Array.isArray(pre)) throw new Error(`"hooks.PreToolUse" in ${file} is not an array.`);
  const existing = pre.find((e) => Array.isArray(e?.hooks) && e.hooks.some((h: any) => h?.command === cmd));
  if (existing) {
    if (existing.matcher === CLAUDE_MATCHER) return [`Already installed in ${file}. No changes made.`];
    const old = existing.matcher;
    existing.matcher = CLAUDE_MATCHER;
    const bk = backup(file);
    writeClaude(file, settings);
    return [`Backup: ${bk}`, `Changed: ${file}`, `Updated Cephalo matcher in hooks.PreToolUse: "${old}" -> "${CLAUDE_MATCHER}"`];
  }
  const out: string[] = [];
  if (existed) out.push(`Backup: ${backup(file)}`);
  else out.push(`Backup: none (${file} did not exist, creating it)`);
  const entry = { matcher: CLAUDE_MATCHER, hooks: [{ type: "command", command: cmd }] };
  pre.push(entry);
  writeClaude(file, settings);
  out.push(`Changed: ${file}`, `Added to hooks.PreToolUse: ${JSON.stringify(entry)}`);
  return out;
}

export function uninstallClaude(file = claudeSettingsPath()): string[] {
  if (!fs.existsSync(file)) return [`${file} does not exist. Nothing to remove.`];
  const settings = readClaude(file);
  const pre = settings.hooks?.PreToolUse;
  if (!Array.isArray(pre)) return [`No hooks.PreToolUse in ${file}. Nothing to remove.`];
  const removed: string[] = [];
  const kept: any[] = [];
  for (const e of pre) {
    if (!isObj(e) || !Array.isArray(e.hooks)) {
      kept.push(e);
      continue;
    }
    const remaining = e.hooks.filter((h: any) => {
      const hit = typeof h?.command === "string" && CLAUDE_CMD_RE.test(h.command);
      if (hit) removed.push(h.command);
      return !hit;
    });
    if (remaining.length === e.hooks.length) kept.push(e);
    else if (remaining.length > 0) kept.push({ ...e, hooks: remaining });
  }
  if (removed.length === 0) return [`No Cephalo entries found in ${file}. No changes made.`];
  const out = [`Backup: ${backup(file)}`];
  if (kept.length > 0) settings.hooks.PreToolUse = kept;
  else delete settings.hooks.PreToolUse;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeClaude(file, settings);
  out.push(`Changed: ${file}`, ...removed.map((c) => `Removed from hooks.PreToolUse: ${c}`));
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

export function installHermes(file = hermesConfigPath(), abs = projectRoot()): string[] {
  if (!fs.existsSync(file)) throw new Error(`${file} does not exist. Is Hermes installed? Not creating it.`);
  const cmd = hermesCommand(abs);
  const doc = loadHermesDoc(file);
  if (isNullNode(doc.get("hooks", true))) doc.set("hooks", doc.createNode({}));
  if (!isMap(doc.get("hooks", true))) throw new Error(`"hooks" in ${file} is not a mapping.`);
  if (isNullNode(doc.getIn(["hooks", "pre_tool_call"], true))) {
    doc.setIn(["hooks", "pre_tool_call"], doc.createNode([]));
  }
  const seq = doc.getIn(["hooks", "pre_tool_call"], true);
  if (!isSeq(seq)) throw new Error(`"hooks.pre_tool_call" in ${file} is not a list.`);
  const dup = (seq as YAMLSeq).items.find((it) => isMap(it) && it.toJSON()?.command === cmd) as YAMLMap | undefined;
  if (dup) {
    const old = dup.toJSON().matcher;
    if (old === HERMES_MATCHER) return [`Already installed in ${file}. No changes made.`];
    dup.set("matcher", doc.createNode(HERMES_MATCHER));
    const m = dup.get("matcher", true);
    if (isScalar(m)) m.type = "QUOTE_DOUBLE";
    const bk = backup(file);
    fs.writeFileSync(file, doc.toString({ lineWidth: 0 }), "utf8");
    return [`Backup: ${bk}`, `Changed: ${file}`, `Updated Cephalo matcher in hooks.pre_tool_call: "${old}" -> "${HERMES_MATCHER}"`];
  }
  const item = doc.createNode({ matcher: HERMES_MATCHER, command: cmd, timeout: 10 }) as YAMLMap;
  for (const pair of item.items) {
    if (isScalar(pair.value) && typeof pair.value.value === "string") pair.value.type = "QUOTE_DOUBLE";
  }
  (seq as YAMLSeq).flow = false;
  (seq as YAMLSeq).add(item);
  const out = [`Backup: ${backup(file)}`];
  fs.writeFileSync(file, doc.toString({ lineWidth: 0 }), "utf8");
  out.push(
    `Changed: ${file}`,
    `Added to hooks.pre_tool_call: matcher "${HERMES_MATCHER}", command "${cmd}", timeout 10`,
  );
  return out;
}

export function uninstallHermes(file = hermesConfigPath()): string[] {
  if (!fs.existsSync(file)) return [`${file} does not exist. Nothing to remove.`];
  const doc = loadHermesDoc(file);
  const seq = doc.getIn(["hooks", "pre_tool_call"], true);
  if (!isSeq(seq)) return [`No hooks.pre_tool_call list in ${file}. Nothing to remove.`];
  const removed: string[] = [];
  for (let i = seq.items.length - 1; i >= 0; i--) {
    const it = seq.items[i];
    const c = isMap(it) ? it.toJSON()?.command : undefined;
    if (typeof c === "string" && HERMES_CMD_RE.test(c)) {
      removed.unshift(c);
      seq.delete(i);
    }
  }
  if (removed.length === 0) return [`No Cephalo entries found in ${file}. No changes made.`];
  const out = [`Backup: ${backup(file)}`];
  if (seq.items.length === 0) {
    doc.deleteIn(["hooks", "pre_tool_call"]);
    const hooks = doc.get("hooks", true);
    if (isMap(hooks) && hooks.items.length === 0) doc.delete("hooks");
  }
  fs.writeFileSync(file, doc.toString({ lineWidth: 0 }), "utf8");
  out.push(`Changed: ${file}`, ...removed.map((c) => `Removed from hooks.pre_tool_call: ${c}`));
  return out;
}
