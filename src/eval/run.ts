import fs from "node:fs";
import { evaluate } from "../engine.js";
import { loadEffectiveRules, type Rule } from "../rules.js";
import { judgeOutcome } from "../judge/decide.js";
import { reviewDiff } from "../judge/diffreview.js";
import type { ModelsConfig } from "../models/config.js";
import type { FetchLike } from "../models/ollama.js";

export interface EvalCase {
  id: string;
  kind: "command" | "diff";
  /** risky = a careful person would want to be asked or stopped; safe = should just run. */
  label: "risky" | "safe";
  text: string;
  /** real = harvested (and redacted) from an audit log; written = made up for this set. */
  source: "real" | "written";
  note?: string;
}

/** What the whole system does with a case. */
export type Outcome = "block" | "ask" | "allow";

export interface CaseResult {
  id: string;
  kind: EvalCase["kind"];
  label: EvalCase["label"];
  source: EvalCase["source"];
  /** What the existing rules alone do. */
  rules: Outcome;
  /** What the model said: its verdict, "skipped" (no signal), or "no-answer". */
  model: string;
  modelName?: string;
  p?: number;
  ms: number;
  /** The rules plus the model, in enforce mode with on_unsure/on_failure = ask. */
  final: Outcome;
}

export function parseCases(text: string): EvalCase[] {
  const out: EvalCase[] = [];
  const ids = new Set<string>();
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim() || line.startsWith("#")) return;
    let c: any;
    try {
      c = JSON.parse(line);
    } catch {
      throw new Error(`line ${i + 1}: not valid JSON`);
    }
    if (!c || typeof c.id !== "string" || typeof c.text !== "string" || !c.text) throw new Error(`line ${i + 1}: needs id and text`);
    if (c.kind !== "command" && c.kind !== "diff") throw new Error(`line ${i + 1} (${c.id}): kind must be command or diff`);
    if (c.label !== "risky" && c.label !== "safe") throw new Error(`line ${i + 1} (${c.id}): label must be risky or safe`);
    if (c.source !== "real" && c.source !== "written") throw new Error(`line ${i + 1} (${c.id}): source must be real or written`);
    if (ids.has(c.id)) throw new Error(`line ${i + 1}: duplicate id ${c.id}`);
    ids.add(c.id);
    out.push({ id: c.id, kind: c.kind, label: c.label, source: c.source, text: c.text, ...(typeof c.note === "string" ? { note: c.note } : {}) });
  });
  return out;
}

export function loadCases(file: string): EvalCase[] {
  return parseCases(fs.readFileSync(file, "utf8"));
}

export interface RunEvalOptions {
  config: ModelsConfig;
  fetch?: FetchLike;
  rules?: Rule[];
  /** Never read or write the real judge cache: every case is asked fresh. */
  cacheFile: string;
  onProgress?: (done: number, total: number, r: CaseResult) => void;
}

/**
 * Run every case through the same path the hook uses: rules first, then (commands with a risk signal) the decider, or (diffs) the reviewer.
 * A model that says block/risky or unsure, or gives no answer, escalates to "ask"; rules that block stay "block". That is enforce mode with the default on_unsure/on_failure.
 */
export async function runEval(cases: EvalCase[], o: RunEvalOptions): Promise<CaseResult[]> {
  const rules = o.rules ?? loadEffectiveRules();
  const results: CaseResult[] = [];
  for (const c of cases) {
    const base = { id: c.id, kind: c.kind, label: c.label, source: c.source };
    let r: CaseResult;
    if (c.kind === "command") {
      const rd = evaluate({ command: c.text }, rules).decision;
      const rulesOut: Outcome = rd === "block" ? "block" : "allow";
      if (rulesOut === "block") {
        r = { ...base, rules: "block", model: "not-asked", ms: 0, final: "block" };
      } else {
        const t0 = Date.now();
        const m = await judgeOutcome(c.text, { config: o.config, fetch: o.fetch, cacheFile: o.cacheFile });
        const ms = Date.now() - t0;
        if (m.kind === "skipped") r = { ...base, rules: "allow", model: "skipped", ms: 0, final: "allow" };
        else if (m.kind === "failed") r = { ...base, rules: "allow", model: "no-answer", ms, final: "ask" };
        else r = { ...base, rules: "allow", model: m.judgement.verdict, modelName: m.judgement.model, ...(m.judgement.p !== undefined ? { p: m.judgement.p } : {}), ms: m.judgement.cached ? 0 : m.judgement.ms, final: m.judgement.verdict === "allow" ? "allow" : m.judgement.verdict === "block" ? "block" : "ask" };
      }
    } else {
      const t0 = Date.now();
      const m = await reviewDiff(c.text, { config: o.config, fetch: o.fetch, cacheFile: o.cacheFile });
      const ms = Date.now() - t0;
      if (!m) r = { ...base, rules: "allow", model: "no-answer", ms, final: "ask" };
      else r = { ...base, rules: "allow", model: m.verdict, modelName: m.model, ...(m.p !== undefined ? { p: m.p } : {}), ms: m.cached ? 0 : m.ms, final: m.verdict === "ok" ? "allow" : m.verdict === "risky" ? "block" : "ask" };
    }
    results.push(r);
    o.onProgress?.(results.length, cases.length, r);
  }
  return results;
}

export interface Slice {
  n: number;
  risky: number;
  safe: number;
  /** Risky cases the system stopped or asked about. */
  caught: number;
  /** Risky cases the system let through. */
  missed: number;
  /** Safe cases the system stopped or asked about (the user is bothered for nothing). */
  falseAlarms: number;
  /** Of the safe cases, how many were hard-blocked. */
  falseBlocks: number;
  /** Cases a model was actually asked. */
  modelAsked: number;
  noAnswer: number;
  p50ms: number;
  p95ms: number;
}

const pct = (a: number[], q: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};

export function summarize(results: CaseResult[], pick: (r: CaseResult) => Outcome = (r) => r.final): Slice {
  const risky = results.filter((r) => r.label === "risky");
  const safe = results.filter((r) => r.label === "safe");
  const asked = results.filter((r) => r.model !== "skipped" && r.model !== "not-asked");
  const times = asked.filter((r) => r.ms > 0).map((r) => r.ms);
  return {
    n: results.length,
    risky: risky.length,
    safe: safe.length,
    caught: risky.filter((r) => pick(r) !== "allow").length,
    missed: risky.filter((r) => pick(r) === "allow").length,
    falseAlarms: safe.filter((r) => pick(r) !== "allow").length,
    falseBlocks: safe.filter((r) => pick(r) === "block").length,
    modelAsked: asked.length,
    noAnswer: results.filter((r) => r.model === "no-answer").length,
    p50ms: pct(times, 0.5),
    p95ms: pct(times, 0.95),
  };
}

const rate = (a: number, b: number) => (b === 0 ? "n/a" : `${((100 * a) / b).toFixed(0)}%`);

export function formatReport(results: CaseResult[], cases: EvalCase[], models: string): string[] {
  const lines: string[] = [`Models: ${models}`, ""];
  const row = (name: string, s: Slice, pick: string) =>
    `  ${name.padEnd(22)} ${String(s.n).padStart(3)} cases | caught ${s.caught}/${s.risky} (${rate(s.caught, s.risky)}) | false alarms ${s.falseAlarms}/${s.safe} (${rate(s.falseAlarms, s.safe)})${s.falseBlocks ? `, ${s.falseBlocks} hard-blocked` : ""} | ${pick}`;
  const commands = results.filter((r) => r.kind === "command");
  const diffs = results.filter((r) => r.kind === "diff");
  lines.push("Rules only (today, judge off):");
  lines.push(row("commands", summarize(commands, (r) => r.rules), "-"));
  lines.push("", "Rules + models (enforce; unsure and no-answer ask the user):");
  const timing = (s: Slice) => `asked ${s.modelAsked}, no answer ${s.noAnswer}, p50 ${s.p50ms} ms, p95 ${s.p95ms} ms`;
  lines.push(row("commands", summarize(commands), timing(summarize(commands))));
  if (diffs.length) lines.push(row("diffs", summarize(diffs), timing(summarize(diffs))));
  for (const src of ["real", "written"] as const) {
    const sl = results.filter((r) => r.source === src);
    if (sl.length) lines.push(row(`  ${src} only`, summarize(sl), ""));
  }
  const byId = new Map(cases.map((c) => [c.id, c]));
  const show = (title: string, rs: CaseResult[]) => {
    if (!rs.length) return;
    lines.push("", title);
    for (const r of rs) {
      const text = (byId.get(r.id)?.text ?? "").replace(/\s+/g, " ").slice(0, 110);
      lines.push(`  ${r.id.padEnd(14)} rules=${r.rules} model=${r.model}${r.p !== undefined ? ` p=${r.p}` : ""}${r.modelName ? ` (${r.modelName})` : ""} final=${r.final}  ${text}`);
    }
  };
  show("MISSED (risky, but allowed):", results.filter((r) => r.label === "risky" && r.final === "allow"));
  show("FALSE ALARMS (safe, but asked or blocked):", results.filter((r) => r.label === "safe" && r.final !== "allow"));
  const unsureRisky = results.filter((r) => r.label === "risky" && r.model === "unsure").length;
  const skippedRisky = results.filter((r) => r.label === "risky" && r.model === "skipped").length;
  lines.push("", `Of the risky cases: ${skippedRisky} never reached a model (no risk signal), ${unsureRisky} were only "unsure" (asked, not blocked).`);
  return lines;
}
