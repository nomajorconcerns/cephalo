import { parseTimeSpec } from "./replay/collect.js";
import { buildCostReport, formatCostReport, type CostReport } from "./cost/report.js";
import { loadPrices } from "./cost/prices.js";
import { ghLookup, shipStatuses, type PrLookup } from "./cost/ship.js";
import { readClaudeSessions, readHermesSessions, type SessionCost } from "./cost/usage.js";

export interface CostArgs {
  since: string;
  json: boolean;
  allProjects: boolean;
  noGithub: boolean;
  rows: number;
}

export const COST_USAGE = `Usage: cephalo cost [--since 7d|2d|today|<date>] [--all-projects] [--json] [--rows N] [--no-github]

What your agent sessions cost and how many of them shipped. "Shipped" = the session's branch has a pull
request that was merged with passing CI on its head commit (looked up with the gh CLI).
Dollars for Claude Code are an estimate: token counts times Anthropic's API list prices (edit ~/.cephalo/prices.yml).
By default only sessions run inside the current directory are counted. --no-github skips the PR lookup.`;

export function parseCostArgs(argv: string[]): { args: CostArgs } | { error: string } {
  const val = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  for (const f of ["--since", "--rows"]) if (argv.includes(f) && (val(f) === undefined || val(f)!.startsWith("--"))) return { error: `${f} needs a value.` };
  const known = new Set(["--since", "--rows", "--all-projects", "--json", "--no-github"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--since" || a === "--rows") {
      i++;
      continue;
    }
    if (!known.has(a)) return { error: `Unknown option ${a}.` };
  }
  const rows = val("--rows") === undefined ? 10 : Number(val("--rows"));
  if (!Number.isInteger(rows) || rows < 0) return { error: "--rows needs a whole number." };
  return { args: { since: val("--since") ?? "7d", json: argv.includes("--json"), allProjects: argv.includes("--all-projects"), noGithub: argv.includes("--no-github"), rows } };
}

const norm = (p: string) => p.split("\\").join("/").replace(/\/+$/, "").toLowerCase();
const inside = (cwd: string | undefined, root: string) => !!cwd && (norm(cwd) === norm(root) || norm(cwd).startsWith(norm(root) + "/"));

export interface CostEnv {
  cwd: string;
  now?: Date;
  lookup?: PrLookup;
  claudeDir?: string;
  hermesDb?: string;
  pricesFile?: string;
}

export async function costReport(a: CostArgs, env: CostEnv): Promise<{ report: CostReport; lines: string[] }> {
  const since = parseTimeSpec(a.since, env.now);
  const { prices, notes } = loadPrices(env.pricesFile);
  let sessions: SessionCost[] = [...readClaudeSessions(since, prices, env.claudeDir), ...(await readHermesSessions(since, env.hermesDb))];
  if (!a.allProjects) sessions = sessions.filter((s) => inside(s.cwd, env.cwd));
  const ship = a.noGithub ? new Map(sessions.map((s) => [s, { status: "unknown" as const }])) : shipStatuses(sessions, env.lookup ?? ghLookup);
  const report = buildCostReport(sessions, ship, since);
  report.notes.push(...notes);
  const lines = formatCostReport(report, { rows: a.rows });
  if (!a.allProjects) lines.push("", `Only sessions run inside ${env.cwd}. Add --all-projects for everything.`);
  return { report, lines };
}
