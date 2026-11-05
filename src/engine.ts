import { getPlatform, type PlatformAdapter } from "./platform.js";
import { analyzeCommand, type Analysis } from "./analyze.js";
import { resolvedPathVariants } from "./paths.js";
import { SYSTEM_RULES } from "./platform-rules.js";
import { loadEffectiveRules, type Rule } from "./rules.js";

export interface EvalInput {
  command?: string;
  path?: string;
  access?: "read" | "write";
  /** The agent session's working directory. A relative `path` is resolved against it before path rules run. */
  cwd?: string;
}

/** A rule that matched but was only logged: it is in shadow mode, so nothing was blocked or asked. */
export interface ShadowHit {
  rule: Rule;
  would: "block" | "ask";
}

export interface EvalResult {
  decision: "allow" | "block" | "ask";
  /** The rule behind a block or an ask. */
  rule?: Rule;
  /** An `action: allow` rule that exempted the call from a later rule. */
  allowedBy?: Rule;
  /** Rules in shadow mode that matched. They changed nothing; they are for the log. */
  shadow?: ShadowHit[];
}

export interface EvalOptions {
  /** Shadow mode for every rule except Cephalo's own protections (the config's `shadow: true`). */
  shadowAll?: boolean;
}

/** The raw value first, then the platform-normalized variant if it differs (never weaker than raw matching). */
function variants(raw: string, norm: (s: string) => string): string[] {
  let n = raw;
  try {
    n = norm(raw);
  } catch {
    /* normalization must never break evaluation */
  }
  return n === raw ? [raw] : [raw, n];
}

/** Cephalo's own protections. An `allow` rule cannot exempt a call from these, and shadow mode does not switch them off. */
const LOCKED = new Set(SYSTEM_RULES.map((r) => r.id));

interface Unit {
  texts: string[];
  /** May an `action: allow` rule exempt this text? Only for text the parser read cleanly. */
  allow: boolean;
}

interface Verdict {
  decision: "allow" | "block" | "ask" | "none";
  rule?: Rule;
  allowedBy?: Rule;
}

/**
 * Evaluate a tool call against the rules. Rules default to the user's rules file
 * (created from built-in defaults if missing); pass `rules` to override (used by tests).
 *
 * A command is checked as written AND piece by piece (see analyze.ts): each command of a pipeline or && chain, the code
 * inside `bash -c` / `python -c` / `eval`, command substitutions. The strictest answer wins (block, then ask, then
 * allow), so reading the command can only add blocks. If the command cannot be parsed, only the raw text is checked
 * and `action: allow` rules do not apply to it.
 */
export function evaluate(
  input: EvalInput,
  rules: Rule[] = loadEffectiveRules(),
  platform: PlatformAdapter = getPlatform(),
  opts: EvalOptions = {},
): EvalResult {
  const compiled: Array<RegExp | null> = rules.map((rule) => {
    try {
      return new RegExp(rule.pattern, "i");
    } catch (e) {
      process.stderr.write(`cephalo: invalid pattern in rule ${rule.id}: ${(e as Error).message}\n`);
      return null;
    }
  });
  const shadow: ShadowHit[] = [];

  const walk = (kind: "command" | "path", unit: Unit, access: "read" | "write"): Verdict => {
    let allowedBy: Rule | undefined;
    for (let k = 0; k < rules.length; k++) {
      const rule = rules[k]!;
      const re = compiled[k];
      if (!re || rule.type !== kind) continue;
      if (kind === "path") {
        const on = rule.on ?? "any";
        if (on !== "any" && on !== access) continue;
      }
      const action = rule.action ?? "block";
      if (action === "allow" && !unit.allow) continue;
      if (allowedBy && !LOCKED.has(rule.id)) continue; // after an exception only Cephalo's own protections still apply
      if (!unit.texts.some((t) => re.test(t))) continue;
      if (action === "allow") {
        allowedBy ??= rule;
        continue;
      }
      if (rule.shadow || (opts.shadowAll && !LOCKED.has(rule.id))) {
        if (!shadow.some((s) => s.rule.id === rule.id)) shadow.push({ rule, would: action });
        continue;
      }
      return { decision: action, rule };
    }
    return allowedBy ? { decision: "allow", allowedBy } : { decision: "none" };
  };

  const verdicts: Verdict[] = [];

  if (input.command !== undefined) {
    let analysis: Analysis | null = null;
    try {
      analysis = analyzeCommand(input.command);
    } catch {
      analysis = null; // parsing must never break evaluation: text matching only
    }
    const norm = (s: string) => platform.normalizeCommand(s);
    const rawTexts = variants(input.command, norm);
    verdicts.push(walk("command", { texts: rawTexts, allow: !!analysis && analysis.ok && analysis.single }, "read"));
    if (analysis) {
      const seen = new Set(rawTexts);
      for (const u of analysis.units) {
        if (seen.has(u)) continue;
        seen.add(u);
        verdicts.push(walk("command", { texts: variants(u, norm), allow: analysis.ok }, "read"));
      }
    }
  }

  if (input.path !== undefined) {
    // Raw and normalized first (as before), then where the path really points: against the session's cwd, and with symlinks resolved.
    const paths = [...new Set([...variants(input.path, (s) => platform.normalizePath(s)), ...resolvedPathVariants(input.path, input.cwd, platform)])];
    if (paths.length) verdicts.push(walk("path", { texts: paths, allow: true }, input.access ?? "read"));
  }

  const pick = (d: "block" | "ask") => verdicts.find((v) => v.decision === d);
  const out = pick("block") ?? pick("ask");
  const extra = shadow.length ? { shadow } : {};
  if (out) return { decision: out.decision as "block" | "ask", rule: out.rule, ...extra };
  const allowed = verdicts.find((v) => v.decision === "allow");
  return { decision: "allow", ...(allowed?.allowedBy ? { allowedBy: allowed.allowedBy } : {}), ...extra };
}
