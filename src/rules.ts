import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";

export type RuleType = "command" | "path";
export type RuleOn = "read" | "write" | "any";

export interface Rule {
  id: string;
  description: string;
  type: RuleType;
  on?: RuleOn; // path rules only
  pattern: string;
  action: "block";
}

export const DEFAULT_RULES: Rule[] = [
  { id: "no-drop", description: "Dropping tables or databases", type: "command", pattern: "\\bDROP\\s+(TABLE|DATABASE|SCHEMA)\\b", action: "block" },
  { id: "no-truncate", description: "Truncating tables", type: "command", pattern: "\\bTRUNCATE\\s+(TABLE\\s+)?[\\w.\"]+", action: "block" },
  { id: "no-delete-all", description: "DELETE FROM with no WHERE clause", type: "command", pattern: "\\bDELETE\\s+FROM\\s+[\\w.\"]+\\s*(;|\"|$)", action: "block" },
  { id: "no-rm-rf", description: "Recursive forced rm", type: "command", pattern: "\\brm\\s+-(?=[a-z]*r)(?=[a-z]*f)[a-z]+", action: "block" },
  { id: "no-win-recursive-delete", description: "Recursive delete on Windows", type: "command", pattern: "(Remove-Item\\b(?=.*-Recurse)(?=.*-Force))|(\\b(rd|rmdir)\\s+\\/s\\b)|(\\bdel\\s+.*\\/s\\b)", action: "block" },
  { id: "no-force-push", description: "Force pushing to git remotes", type: "command", pattern: "\\bgit\\s+push\\b(?=.*(\\s--force(?!-with-lease)\\b|\\s-f\\b))", action: "block" },
  { id: "no-hard-reset", description: "git reset --hard", type: "command", pattern: "\\bgit\\s+reset\\s+--hard\\b", action: "block" },
  { id: "no-secret-read", description: "Reading .env secret files via shell", type: "command", pattern: "\\b(cat|type|Get-Content|gc|more|less|head|tail)\\b.*\\.env\\b(?!\\.example)", action: "block" },
  { id: "no-secret-file", description: "Accessing .env secret files", type: "path", on: "any", pattern: "(^|[\\/\\\\])\\.env(\\.(?!example$)[\\w.-]+)?$", action: "block" },
  { id: "protect-config", description: "Writing Cephalo, Claude Code or Hermes config", type: "path", on: "write", pattern: "[\\/\\\\]\\.cephalo[\\/\\\\]|[\\/\\\\]\\.claude[\\/\\\\]settings(\\.local)?\\.json$|[\\/\\\\]hermes[\\/\\\\]config\\.yaml$", action: "block" },
  { id: "no-cephalo-tamper", description: "Installing or uninstalling Cephalo hooks", type: "command", pattern: "\\bcephalo\\s+(install|uninstall)\\b|cli\\.js\\s+(install|uninstall)\\b", action: "block" },
];

export function cephaloDir(): string {
  return path.join(os.homedir(), ".cephalo");
}

export function defaultRulesPath(): string {
  return path.join(cephaloDir(), "rules.yml");
}

const HEADER =
  "# Cephalo rules. Patterns are case-insensitive JavaScript regexes.\n" +
  "# type: command | path    on (path rules only): read | write | any\n";

/** Create the rules file from built-in defaults if it does not exist. */
export function ensureRulesFile(file: string = defaultRulesPath()): void {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, HEADER + stringify({ rules: DEFAULT_RULES }), "utf8");
}

/** Load rules from file (creating it from defaults if missing). Invalid entries are skipped with a warning. */
export function loadRules(file: string = defaultRulesPath()): Rule[] {
  ensureRulesFile(file);
  const doc = parse(fs.readFileSync(file, "utf8")) as { rules?: unknown } | null;
  const list = Array.isArray(doc?.rules) ? (doc!.rules as Record<string, unknown>[]) : [];
  const out: Rule[] = [];
  for (const r of list) {
    if (
      typeof r?.id !== "string" ||
      typeof r.pattern !== "string" ||
      (r.type !== "command" && r.type !== "path")
    ) {
      process.stderr.write(`cephalo: skipping malformed rule ${JSON.stringify(r)}\n`);
      continue;
    }
    out.push({
      id: r.id,
      description: typeof r.description === "string" ? r.description : r.id,
      type: r.type,
      on: r.on === "read" || r.on === "write" || r.on === "any" ? r.on : "any",
      pattern: r.pattern,
      action: "block",
    });
  }
  return out;
}
