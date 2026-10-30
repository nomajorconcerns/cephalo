import { loadRules, type Rule } from "./rules.js";

export interface EvalInput {
  command?: string;
  path?: string;
  access?: "read" | "write";
}

export interface EvalResult {
  decision: "allow" | "block";
  rule?: Rule;
}

/**
 * Evaluate a tool call against the rules. Rules default to the user's rules file
 * (created from built-in defaults if missing); pass `rules` to override (used by tests).
 */
export function evaluate(input: EvalInput, rules: Rule[] = loadRules()): EvalResult {
  for (const rule of rules) {
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, "i");
    } catch (e) {
      process.stderr.write(`cephalo: invalid pattern in rule ${rule.id}: ${(e as Error).message}\n`);
      continue;
    }
    if (rule.type === "command") {
      if (input.command !== undefined && re.test(input.command)) return { decision: "block", rule };
    } else if (rule.type === "path") {
      if (input.path === undefined) continue;
      const on = rule.on ?? "any";
      const access = input.access ?? "read";
      if (on !== "any" && on !== access) continue;
      if (re.test(input.path)) return { decision: "block", rule };
    }
  }
  return { decision: "allow" };
}
