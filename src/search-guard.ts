import fs from "node:fs";
import path from "node:path";
import type { Rule } from "./rules.js";

/**
 * Grep, Glob and Hermes' search_files read file contents or list files without going through a shell, so the shell rule
 * for .env files never sees them. This guard looks at what a search is aimed at:
 *   - its path (also checked by the path rules, including symlink and cwd resolution),
 *   - its file filter (`glob`, `file_glob`) or, for Glob, its pattern, and
 *   - when no filter narrows it, whether the folder being searched holds a .env file.
 * It is a check on what the call names, not a sandbox: a search the agent builds some other way is not covered.
 */
export const SEARCH_ENV_RULE: Rule = {
  id: "no-secret-search",
  description: "Searching or listing .env secret files with Grep, Glob or search_files (name a narrower folder or file filter)",
  type: "path",
  on: "read",
  pattern: "",
  action: "block",
};

/** A .env file, but not the .example/.sample/.template copies that hold no secrets. */
const ENV_MENTION = /(^|[\\/*{,\s])\.env(?![A-Za-z0-9_-])(?!\.(example|sample|template)\b)/i;

/** True when a glob or file name text refers to .env files (`.env`, `**\/.env*`, `{.env,.env.local}`). */
export function mentionsEnvFile(text: string | undefined): boolean {
  return !!text && ENV_MENTION.test(text);
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", "dist", "build", "target", ".venv", "venv", "__pycache__", ".next", ".cache"]);

/** Is there a .env file (not .example) in `dir` or up to `depth` folders below it? Bounded; never throws. */
export function dirHoldsEnvFile(dir: string, depth = 3, budget = { left: 4000 }): boolean {
  if (depth < 0 || budget.left <= 0) return false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (--budget.left <= 0) return false;
    if (e.isFile() && mentionsEnvFile(`/${e.name}`)) return true;
  }
  for (const e of entries) {
    if (e.isDirectory() && !SKIP_DIRS.has(e.name) && dirHoldsEnvFile(path.join(dir, e.name), depth - 1, budget)) return true;
  }
  return false;
}

export interface SearchTarget {
  /** The file or folder searched. Absent means the session's working directory. */
  path?: string;
  /** File filters the call carries (Grep `glob`, search_files `file_glob`, Glob `pattern`). */
  globs: string[];
  /** The session's working directory, used when `path` is absent or relative. */
  cwd?: string;
}

/** The rule this search trips, if any. */
export function checkSearch(t: SearchTarget): Rule | undefined {
  if (t.globs.some((g) => mentionsEnvFile(g))) return SEARCH_ENV_RULE;
  if (t.globs.length > 0) return undefined; // a filter that does not name .env narrows the search
  const base = t.path && path.isAbsolute(t.path) ? t.path : t.path ? path.resolve(t.cwd ?? process.cwd(), t.path) : t.cwd;
  if (!base) return undefined;
  let isDir = false;
  try {
    isDir = fs.statSync(base).isDirectory();
  } catch {
    return undefined;
  }
  return isDir && dirHoldsEnvFile(base) ? SEARCH_ENV_RULE : undefined;
}
