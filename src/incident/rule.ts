import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { parseDocument } from "yaml";
import { evaluate, type EvalInput } from "../engine.js";
import { entrySubject, type AuditEntry } from "../audit.js";
import { getPlatform, type PlatformAdapter } from "../platform.js";
import { defaultRulesPath, parseRules, type Rule } from "../rules.js";
import { commandCandidates, pathCandidates, type Candidate } from "./derive.js";

export const LEARNED_PREFIX = "learned-";
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "write_file", "patch"]);

/** What the engine would have been asked for this log entry (null when the entry has nothing a rule can match). */
export function inputOf(e: AuditEntry): EvalInput | null {
  if (e.command !== undefined) return { command: e.command };
  if (e.path !== undefined) return { path: e.path, access: WRITE_TOOLS.has(e.tool) ? "write" : "read" };
  return null;
}

export interface Assessment {
  candidate: Candidate;
  rule: Rule;
  /** Hard problems: the rule must not be applied. */
  errors: string[];
  /** Things to look at before applying. */
  warnings: string[];
  catchesIncident: boolean;
  /** Distinct earlier actions that were allowed and this rule would have blocked. */
  wouldHaveBlocked: { count: number; examples: string[] };
  /** Distinct earlier allowed actions checked. */
  checked: number;
  /** Milliseconds for the slowest test string. */
  slowestMs: number;
}

const SAMPLE_LIMIT = 4;

/** Strings built to make a badly written pattern backtrack. */
function stress(): string[] {
  const a = "a".repeat(4000);
  return [a, `${a}!`, "x ".repeat(2500), `git ${"-f ".repeat(1200)}`, `${"/".repeat(2000)}.${"\\".repeat(2000)}`, `${"ab".repeat(2000)}c`];
}

const WATCHDOG_MS = 100;

/** Time one match inside a vm context with a watchdog, so a catastrophic pattern is cut off instead of hanging us. Returns Infinity when cut off. */
function timeIt(pattern: string, s: string): number {
  const t = process.hrtime.bigint();
  try {
    new vm.Script("new RegExp(p, 'i').test(s)").runInNewContext({ p: pattern, s }, { timeout: WATCHDOG_MS });
  } catch {
    return Infinity;
  }
  return Number(process.hrtime.bigint() - t) / 1e6;
}

export function ruleFrom(c: Candidate, incident: AuditEntry, taken: Set<string>): Rule {
  let id = `${LEARNED_PREFIX}${c.slug}`;
  for (let n = 2; taken.has(id); n++) id = `${LEARNED_PREFIX}${c.slug}-${n}`;
  const day = incident.ts.slice(0, 10);
  return { id, description: `Learned from an incident on ${day}: ${c.title}`, type: c.type, ...(c.type === "path" ? { on: c.on ?? "any" } : {}), pattern: c.pattern, action: "block" };
}

export function candidatesFor(e: AuditEntry, o: { segment?: number } = {}): { candidates: Candidate[]; note?: string; segments?: string[]; segment?: string } {
  if (e.command !== undefined) {
    const r = commandCandidates(e.command, o);
    return { candidates: r.candidates, note: r.note, segments: r.segments, segment: r.segment };
  }
  if (e.path !== undefined) return { candidates: pathCandidates(e.path, e.tool) };
  return { candidates: [], note: "That entry has no command or path, so there is nothing for a rule to match (MCP calls are controlled with `cephalo mcp`)." };
}

export function assess(c: Candidate, incident: AuditEntry, history: AuditEntry[], existing: Rule[], platform: PlatformAdapter = getPlatform()): Assessment {
  const rule = ruleFrom(c, incident, new Set(existing.map((r) => r.id)));
  const errors: string[] = [];
  const warnings: string[] = [];
  let slowestMs = 0;
  let re: RegExp | null = null;
  try {
    re = new RegExp(rule.pattern, "i");
  } catch (e) {
    errors.push(`the pattern does not compile: ${(e as Error).message}`);
  }
  if (re) {
    for (const s of stress()) {
      // A busy machine can make a good pattern look slow once. A catastrophic pattern is slow every time, so take the best of up to three tries.
      let best = timeIt(rule.pattern, s);
      for (let k = 0; k < 2 && best > 50; k++) best = Math.min(best, timeIt(rule.pattern, s));
      slowestMs = Math.max(slowestMs, best);
      if (slowestMs === Infinity) break;
    }
    if (slowestMs > 50) errors.push(`the pattern is slow on adversarial input (${slowestMs === Infinity ? `over ${WATCHDOG_MS} ms, cut off` : `${slowestMs.toFixed(0)} ms`}), which could stall every tool call`);
    if (re.test("")) errors.push("the pattern matches empty text, so it would block everything");
  }

  const input = inputOf(incident);
  const catchesIncident = !!(input && !errors.length && evaluate(input, [rule], platform).decision === "block");
  if (!catchesIncident && !errors.length) errors.push("the rule would not have caught the incident it was built from");

  // what it would have done to ordinary work
  const seen = new Set<string>();
  const examples: string[] = [];
  let count = 0;
  let checked = 0;
  if (!errors.length) {
    for (const h of history) {
      if (h === incident || h.decision !== "allow") continue;
      const i = inputOf(h);
      if (!i) continue;
      const key = `${i.command ?? ""}\u0000${i.path ?? ""}\u0000${i.access ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      checked++;
      if (key === `${input?.command ?? ""}\u0000${input?.path ?? ""}\u0000${input?.access ?? ""}`) continue;
      if (evaluate(i, [rule], platform).decision === "block") {
        count++;
        if (examples.length < SAMPLE_LIMIT) examples.push(entrySubject(h).replace(/\s+/g, " ").slice(0, 120));
      }
    }
    if (checked >= 10 && count / checked > 0.2) warnings.push(`it would have blocked ${count} of ${checked} different things the agents did (${Math.round((100 * count) / checked)}%). That is a lot of normal work`);
    else if (count > 0) warnings.push(`it would also have blocked ${count} earlier action${count === 1 ? "" : "s"} that went through fine`);
    if (c.level === "broad") warnings.push("this is the broadest option; it stops the whole kind of action, not just the risky use");
  }

  // duplicates of existing behaviour
  if (!errors.length && input) {
    const already = evaluate(input, existing, platform);
    if (already.decision === "block") warnings.push(`rule "${already.rule!.id}" already blocks this exact action, so the new rule would only matter where that one is switched off or bypassed`);
  }
  return { candidate: c, rule, errors, warnings, catchesIncident, wouldHaveBlocked: { count, examples }, checked, slowestMs };
}

/* ------------------------------------------------------------------ writing the rules file */

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

export interface ApplyResult {
  ok: boolean;
  lines: string[];
  backup?: string;
}

/** Append a rule to rules.yml, keeping comments and other rules as they are. A backup is made first and the result is re-read and re-tested. */
export function applyRule(rule: Rule, incident: AuditEntry, file: string = defaultRulesPath(), platform: PlatformAdapter = getPlatform()): ApplyResult {
  if (!fs.existsSync(file)) return { ok: false, lines: [`There is no rules file at ${file} yet. Run any cephalo command that loads rules (for example: cephalo rules) to create it, then try again.`] };
  const before = fs.readFileSync(file, "utf8");
  const parsed = parseRules(before);
  if (parsed.problems.length) return { ok: false, lines: ["The rules file has problems, so nothing was changed:", ...parsed.problems.map((p) => `  ${p}`)] };
  if (parsed.rules.some((r) => r.id === rule.id)) return { ok: false, lines: [`A rule named ${rule.id} already exists. Nothing was changed.`] };

  const doc = parseDocument(before);
  const seq = doc.get("rules", true) as { add?: (v: unknown) => void } | undefined;
  if (!seq || typeof seq.add !== "function") return { ok: false, lines: ["Could not find the rules list in the file. Nothing was changed."] };
  seq.add(doc.createNode({ id: rule.id, description: rule.description, type: rule.type, ...(rule.type === "path" ? { on: rule.on ?? "any" } : {}), pattern: rule.pattern, action: "block" }));
  const after = doc.toString();

  const check = parseRules(after);
  const got = check.rules.find((r) => r.id === rule.id);
  const input = inputOf(incident);
  if (check.problems.length || !got || got.pattern !== rule.pattern || check.rules.length !== parsed.rules.length + 1 || !input || evaluate(input, [got], platform).decision !== "block") {
    return { ok: false, lines: ["The new file did not read back correctly, so nothing was changed."] };
  }
  const backup = `${file}.cephalo-backup-${stamp()}`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, after, "utf8");
  return { ok: true, backup, lines: [`Added rule ${rule.id} to ${file}`, `Backup of the previous file: ${backup}`, `It applies to new tool calls straight away. To remove it: cephalo incident undo ${rule.id}`] };
}

/** Remove one learned rule. Only ids that this feature created can be removed this way. */
export function undoRule(id: string, file: string = defaultRulesPath()): ApplyResult {
  if (!id.startsWith(LEARNED_PREFIX)) return { ok: false, lines: [`Only rules created by \`cephalo incident\` (ids starting with "${LEARNED_PREFIX}") can be removed this way. Edit ${file} for others.`] };
  if (!fs.existsSync(file)) return { ok: false, lines: [`No rules file at ${file}.`] };
  const before = fs.readFileSync(file, "utf8");
  const doc = parseDocument(before);
  const seq = doc.get("rules", true) as { items?: Array<{ get?: (k: string) => unknown }> } | undefined;
  const items = seq?.items ?? [];
  const idx = items.findIndex((it) => it.get?.("id") === id);
  if (idx < 0) return { ok: false, lines: [`No rule with id ${id} in ${file}.`] };
  doc.deleteIn(["rules", idx]);
  const after = doc.toString();
  const check = parseRules(after);
  if (check.problems.length || check.rules.some((r) => r.id === id)) return { ok: false, lines: ["The new file did not read back correctly, so nothing was changed."] };
  const backup = `${file}.cephalo-backup-${stamp()}`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, after, "utf8");
  return { ok: true, backup, lines: [`Removed rule ${id}.`, `Backup of the previous file: ${backup}`] };
}

export const learnedRules = (rules: Rule[]) => rules.filter((r) => r.id.startsWith(LEARNED_PREFIX));
export const dirOf = (f: string) => path.dirname(f);
