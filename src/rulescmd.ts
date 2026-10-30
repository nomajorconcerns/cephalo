import fs from "node:fs";
import { DEFAULT_RULES, defaultRulesPath, parseRules, writeDefaultRules, type Rule } from "./rules.js";

type Origin = "default" | "modified" | "custom";

function originOf(r: Rule): Origin {
  const d = DEFAULT_RULES.find((x) => x.id === r.id);
  if (!d) return "custom";
  const same = d.type === r.type && d.pattern === r.pattern && (d.on ?? "any") === (r.on ?? "any");
  return same ? "default" : "modified";
}

function load(file: string): { rules: Rule[]; problems: string[] } | null {
  if (!fs.existsSync(file)) return null;
  return parseRules(fs.readFileSync(file, "utf8"));
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

/** `cephalo rules` / `cephalo rules list` */
export function listRules(file: string = defaultRulesPath()): { lines: string[]; exitCode: number } {
  const loaded = load(file);
  if (!loaded) {
    return { lines: [`No rules file at ${file} yet. It is created from the defaults on first use (or run: cephalo init).`], exitCode: 0 };
  }
  const { rules, problems } = loaded;
  const idw = Math.max(2, ...rules.map((r) => r.id.length));
  const lines = [`Rules file: ${file}`, ""];
  lines.push(`${pad("ID", idw)}  ${pad("TYPE", 7)}  ${pad("ON", 5)}  ${pad("ORIGIN", 8)}  DESCRIPTION`);
  for (const r of rules) {
    lines.push(`${pad(r.id, idw)}  ${pad(r.type, 7)}  ${pad(r.type === "path" ? r.on ?? "any" : "-", 5)}  ${pad(originOf(r), 8)}  ${r.description}`);
  }
  const have = new Set(rules.map((r) => r.id));
  const missing = DEFAULT_RULES.map((r) => r.id).filter((id) => !have.has(id));
  lines.push("");
  lines.push(`${rules.length} rule(s). Missing defaults: ${missing.length ? missing.join(", ") : "none"}.`);
  for (const p of problems) lines.push(`Problem: ${p}`);
  return { lines, exitCode: problems.length ? 1 : 0 };
}

/** `cephalo rules show <id>` */
export function showRule(id: string | undefined, file: string = defaultRulesPath()): { lines: string[]; exitCode: number } {
  if (!id) return { lines: ["Usage: cephalo rules show <id>"], exitCode: 1 };
  const loaded = load(file);
  const r = loaded?.rules.find((x) => x.id === id);
  if (!r) return { lines: [`No rule with id "${id}" in ${file}. See: cephalo rules`], exitCode: 1 };
  const lines = [
    `id:          ${r.id}`,
    `description: ${r.description}`,
    `type:        ${r.type}`,
    ...(r.type === "path" ? [`on:          ${r.on ?? "any"}`] : []),
    `action:      ${r.action}`,
    `origin:      ${originOf(r)}`,
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
