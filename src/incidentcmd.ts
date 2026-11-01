import { entrySubject, readAudit, type AuditEntry } from "./audit.js";
import { getPlatform, type PlatformAdapter } from "./platform.js";
import { defaultRulesPath, loadEffectiveRules, parseRules, type Rule } from "./rules.js";
import { sanitize } from "./watch.js";
import { assess, candidatesFor, inputOf, learnedRules, LEARNED_PREFIX, type Assessment } from "./incident/rule.js";
import fs from "node:fs";

export interface IncidentArgs {
  sub: "list" | "show" | "learned" | "undo";
  /** 1-based position in the audit log. */
  n?: number;
  last: boolean;
  use?: number;
  segment?: number;
  yes: boolean;
  limit: number;
  id?: string;
}

export const INCIDENT_USAGE = `Usage: cephalo incident [list | <n> | --last | learned | undo <id>] [options]

Turn something an agent did into a blocking rule.

  cephalo incident              list recent actions with their numbers
  cephalo incident 412          show rule options for action number 412, each tested against your history
  cephalo incident --last       the same for the most recent action
  cephalo incident 412 --use 2  add option 2 (asks first; --yes skips the question)
  cephalo incident learned      list rules created this way
  cephalo incident undo <id>    remove one of them

Options:
  --segment N   for a chained command (a && b), build the rule from part N (starting at 1)
  --limit N     how many actions to list (default 15)

Nothing is changed unless you pass --use. The rules file is backed up first.`;

export function parseIncidentArgs(argv: string[]): { args: IncidentArgs } | { error: string } {
  const a: IncidentArgs = { sub: "list", last: false, yes: false, limit: 15 };
  const pos: string[] = [];
  const num = (flag: string, v: string | undefined, min: number): number | string => {
    const n = Number(v);
    return v !== undefined && /^\d+$/.test(v) && n >= min ? n : `${flag} needs a whole number${min ? ` of at least ${min}` : ""}`;
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--last") a.last = true;
    else if (t === "--yes" || t === "-y") a.yes = true;
    else if (t === "--use" || t === "--segment" || t === "--limit") {
      const r = num(t, argv[++i], t === "--limit" ? 1 : 1);
      if (typeof r === "string") return { error: r };
      if (t === "--use") a.use = r;
      else if (t === "--segment") a.segment = r - 1;
      else a.limit = r;
    } else if (t.startsWith("-")) return { error: `Unknown option ${t}. See: cephalo incident --help` };
    else pos.push(t);
  }
  const first = pos[0];
  if (first === "undo") {
    if (!pos[1]) return { error: "undo needs a rule id. See: cephalo incident learned" };
    return { args: { ...a, sub: "undo", id: pos[1] } };
  }
  if (first === "learned") return { args: { ...a, sub: "learned" } };
  if (first === "list" || (first === undefined && !a.last)) return { args: { ...a, sub: "list" } };
  if (a.last) return { args: { ...a, sub: "show" } };
  if (/^\d+$/.test(first) && Number(first) >= 1) return { args: { ...a, sub: "show", n: Number(first) } };
  return { error: `Do not know "${first}". Use a number from \`cephalo incident\`, --last, learned or undo.` };
}

export interface IncidentEnv {
  auditFile?: string;
  rulesFile?: string;
  platform?: PlatformAdapter;
}

export interface IncidentPlan {
  lines: string[];
  exitCode: number;
  /** Set when the user asked for an option and it passed every check: the CLI confirms, then applies. */
  apply?: { rule: Rule; entry: AuditEntry };
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Entries a rule could be written for, with their position in the full log. */
function actionable(file?: string): Array<{ n: number; e: AuditEntry }> {
  const all = readAudit({ limit: 0 }, file);
  return all.map((e, i) => ({ n: i + 1, e })).filter(({ e }) => inputOf(e) !== null);
}

export function planIncident(a: IncidentArgs, env: IncidentEnv = {}): IncidentPlan {
  const platform = env.platform ?? getPlatform();
  const rulesFile = env.rulesFile ?? defaultRulesPath();

  if (a.sub === "learned") {
    const parsed = fs.existsSync(rulesFile) ? parseRules(fs.readFileSync(rulesFile, "utf8")) : { rules: [], problems: [] };
    const mine = learnedRules(parsed.rules);
    if (!mine.length) return { lines: ["No rules have been created from incidents yet."], exitCode: 0 };
    return { lines: [`${mine.length} learned rule(s):`, ...mine.map((r) => `  ${r.id}  ${r.description}`), "", "Remove one with: cephalo incident undo <id>"], exitCode: 0 };
  }

  const items = actionable(env.auditFile);
  if (a.sub === "list") {
    if (!items.length) return { lines: ["The audit log has no commands or file accesses yet."], exitCode: 0 };
    const shown = items.slice(-a.limit);
    const lines = [`Last ${shown.length} action(s). Pick one: cephalo incident <number>`, ""];
    for (const { n, e } of shown) {
      const when = e.ts.slice(5, 16).replace("T", " ");
      lines.push(`${pad(String(n), 6)} ${when}  ${pad(e.decision === "block" ? "BLOCKED" : e.decision === "ask" ? "asked" : "allowed", 7)}  ${pad(e.agent, 7)} ${clip(sanitize(entrySubject(e)), 90)}`);
    }
    return { lines, exitCode: 0 };
  }

  // show / use
  const picked = a.last ? items[items.length - 1] : items.find((x) => x.n === a.n);
  if (!picked) {
    return { lines: [a.last ? "The audit log has no commands or file accesses yet." : `No command or file access is number ${a.n}. See: cephalo incident`], exitCode: 1 };
  }
  const { n, e } = picked;
  const all = readAudit({ limit: 0 }, env.auditFile);
  const existing = loadEffectiveRules(rulesFile, platform);
  const { candidates, note, segments, segment } = candidatesFor(e, { segment: a.segment });
  const lines = [`Action #${n}, ${e.ts.slice(0, 19).replace("T", " ")}, ${e.agent}/${e.tool}, ${e.decision === "block" ? `blocked by ${e.rule}` : "allowed"}:`, `  ${clip(sanitize(entrySubject(e)), 200)}`];
  if (segments && segments.length > 1) lines.push(`  (a chain of ${segments.length} commands; building from part ${segments.indexOf(segment!) + 1}: ${clip(sanitize(segment!), 80)}. Choose another with --segment N)`);
  if (!candidates.length) return { lines: [...lines, "", note ?? "No rule options could be built from this."], exitCode: 1 };
  lines.push("");

  const assessed: Assessment[] = candidates.map((c) => assess(c, e, all, existing, platform));
  const usable = (x: Assessment) => x.errors.length === 0;
  assessed.forEach((x, i) => {
    const mark = x.candidate.recommended && usable(x) ? "  (recommended)" : "";
    lines.push(`${i + 1}. ${x.candidate.level.toUpperCase()}: ${x.candidate.title}${mark}`);
    lines.push(`     pattern: ${x.candidate.pattern}`);
    if (usable(x)) lines.push(`     catches this action: yes. Tested against ${x.checked} different earlier action(s): would have blocked ${x.wouldHaveBlocked.count}.`);
    for (const ex of x.wouldHaveBlocked.examples) lines.push(`       e.g. ${sanitize(ex)}`);
    for (const w of x.warnings) lines.push(`     note: ${w}`);
    for (const er of x.errors) lines.push(`     NOT USABLE: ${er}`);
  });

  if (a.use === undefined) {
    lines.push("", `To add one: cephalo incident ${a.last ? "--last" : n} --use <option number>`);
    return { lines, exitCode: 0 };
  }
  const chosen = assessed[a.use - 1];
  if (!chosen) return { lines: [...lines, "", `There is no option ${a.use}. Choose 1 to ${assessed.length}.`], exitCode: 1 };
  if (!usable(chosen)) return { lines: [...lines, "", `Option ${a.use} cannot be used: ${chosen.errors.join("; ")}.`], exitCode: 1 };
  lines.push("", `Rule to add: ${chosen.rule.id}`, `  ${chosen.rule.description}`, `  ${chosen.rule.type}${chosen.rule.type === "path" ? ` (${chosen.rule.on})` : ""} /${chosen.rule.pattern}/i  -> block`);
  return { lines, exitCode: 0, apply: { rule: chosen.rule, entry: e } };
}

export { LEARNED_PREFIX };
