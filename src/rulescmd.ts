import fs from "node:fs";
import { getPlatform, type PlatformAdapter } from "./platform.js";
import { readConfig } from "./config.js";
import { DEFAULT_RULES, activePlatformRules, defaultRulesPath, parseRules, writeDefaultRules, type Rule } from "./rules.js";

type Origin = "default" | "modified" | "custom" | "platform";

function originOf(r: Rule): Origin {
  const d = DEFAULT_RULES.find((x) => x.id === r.id);
  if (!d) return "custom";
  const same = d.type === r.type && d.pattern === r.pattern && (d.on ?? "any") === (r.on ?? "any") && d.action === r.action && !r.shadow;
  return same ? "default" : "modified";
}

function load(file: string): { rules: Rule[]; problems: string[] } | null {
  if (!fs.existsSync(file)) return null;
  return parseRules(fs.readFileSync(file, "utf8"));
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

/** "block", "ask", "allow", with "+shadow" when the rule only logs. */
const actionOf = (r: Rule) => `${r.action ?? "block"}${r.shadow ? "+shadow" : ""}`;

/** `cephalo rules` / `cephalo rules list` */
export function listRules(file: string = defaultRulesPath(), platform: PlatformAdapter = getPlatform(), configFile?: string): { lines: string[]; exitCode: number } {
  const loaded = load(file);
  if (!loaded) {
    return { lines: [`No rules file at ${file} yet. It is created from the defaults on first use (or run: cephalo init).`], exitCode: 0 };
  }
  const { rules, problems } = loaded;
  const idw = Math.max(2, ...rules.map((r) => r.id.length), ...activePlatformRules(rules, platform).map((r) => r.id.length));
  const lines = [`Rules file: ${file}`, ""];
  lines.push(`${pad("ID", idw)}  ${pad("TYPE", 7)}  ${pad("ON", 5)}  ${pad("ACTION", 12)}  ${pad("ORIGIN", 8)}  DESCRIPTION`);
  for (const r of rules) {
    lines.push(`${pad(r.id, idw)}  ${pad(r.type, 7)}  ${pad(r.type === "path" ? r.on ?? "any" : "-", 5)}  ${pad(actionOf(r), 12)}  ${pad(originOf(r), 8)}  ${r.description}`);
  }
  const plat = activePlatformRules(rules, platform);
  for (const r of plat) {
    lines.push(`${pad(r.id, idw)}  ${pad(r.type, 7)}  ${pad(r.type === "path" ? r.on ?? "any" : "-", 5)}  ${pad(actionOf(r), 12)}  ${pad("platform", 8)}  ${r.description}`);
  }
  const have = new Set(rules.map((r) => r.id));
  const missing = DEFAULT_RULES.map((r) => r.id).filter((id) => !have.has(id));
  lines.push("");
  lines.push(`${rules.length} rule(s). Missing defaults: ${missing.length ? missing.join(", ") : "none"}.`);
  lines.push(`${plat.length} built-in ${platform.label} rule(s) also active (not stored in the file; to override one, add a rule with the same id).`);
  const asks = rules.filter((r) => r.action === "ask").length;
  const allows = rules.filter((r) => r.action === "allow").length;
  const shadows = rules.filter((r) => r.shadow).length;
  if (asks || allows || shadows) lines.push(`${allows} allow exception(s), ${asks} ask rule(s), ${shadows} rule(s) in shadow mode (logged as "would block", not blocked).`);
  const cfg = readConfig(configFile);
  if (cfg.config.shadow) lines.push(`Global shadow mode is ON (config.yml): every rule above is only logged, except Cephalo's own protections.`);
  lines.push(`Actions: block (default), allow (an exception; first match wins; cannot lift Cephalo's own protections), ask (you approve in Claude Code; elsewhere it follows ask-default: ${cfg.config.askDefault}). Add "shadow: true" to a rule to try it without blocking.`);
  for (const p of problems) lines.push(`Problem: ${p}`);
  return { lines, exitCode: problems.length ? 1 : 0 };
}

/** `cephalo rules show <id>` */
export function showRule(id: string | undefined, file: string = defaultRulesPath(), platform: PlatformAdapter = getPlatform()): { lines: string[]; exitCode: number } {
  if (!id) return { lines: ["Usage: cephalo rules show <id>"], exitCode: 1 };
  const loaded = load(file);
  const fromFile = loaded?.rules.find((x) => x.id === id);
  const fromPlatform = fromFile ? undefined : activePlatformRules(loaded?.rules ?? [], platform).find((x) => x.id === id);
  const r = fromFile ?? fromPlatform;
  if (!r) return { lines: [`No rule with id "${id}" in ${file}. See: cephalo rules`], exitCode: 1 };
  const lines = [
    `id:          ${r.id}`,
    `description: ${r.description}`,
    `type:        ${r.type}`,
    ...(r.type === "path" ? [`on:          ${r.on ?? "any"}`] : []),
    `action:      ${r.action ?? "block"}${r.shadow ? " (shadow mode: logged as would-block, never blocks)" : ""}`,
    `origin:      ${fromPlatform ? `platform (${platform.label}, built in)` : originOf(r)}`,
    `pattern:     ${r.pattern}`,
  ];
  const d = DEFAULT_RULES.find((x) => x.id === r.id);
  if (d && originOf(r) === "modified") lines.push(`default:     ${d.pattern}`);
  return { lines, exitCode: 0 };
}

export interface ResetOptions {
  file?: string;
  yes: boolean;
  interactive: boolean;
  confirm: () => Promise<boolean>;
  log: (line: string) => void;
}

/** `cephalo rules reset`: back up the current rules file, then rewrite it from the built-in defaults. */
export async function resetRules(o: ResetOptions): Promise<number> {
  const file = o.file ?? defaultRulesPath();
  if (!fs.existsSync(file)) {
    writeDefaultRules(file);
    o.log(`Created ${file} from the built-in defaults (no backup needed, it did not exist).`);
    return 0;
  }
  const loaded = load(file);
  const isDefault =
    loaded &&
    loaded.problems.length === 0 &&
    loaded.rules.length === DEFAULT_RULES.length &&
    loaded.rules.every((r) => originOf(r) === "default");
  if (isDefault) {
    o.log(`${file} already matches the built-in defaults. Nothing to do.`);
    return 0;
  }
  const custom = loaded ? loaded.rules.filter((r) => originOf(r) !== "default").map((r) => `${r.id} (${originOf(r)})`) : [];
  o.log(`This replaces ${file} with the built-in defaults.`);
  if (custom.length) o.log(`Your changes that will be backed up and replaced: ${custom.join(", ")}`);
  if (!o.yes) {
    if (!o.interactive) {
      o.log("Not running in a terminal. Nothing was changed. Re-run with: cephalo rules reset --yes");
      return 1;
    }
    if (!(await o.confirm())) {
      o.log("No changes made.");
      return 0;
    }
  }
  const backup = `${file}.cephalo-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(file, backup);
  writeDefaultRules(file);
  o.log(`Backup: ${backup}`);
  o.log(`Changed: ${file} (${DEFAULT_RULES.length} default rules)`);
  return 0;
}
