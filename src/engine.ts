import { getPlatform, type PlatformAdapter } from "./platform.js";
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

/**
 * Evaluate a tool call against the rules. Rules default to the user's rules file
 * (created from built-in defaults if missing); pass `rules` to override (used by tests).
 */
export function evaluate(
  input: EvalInput,
  rules: Rule[] = loadRules(),
  platform: PlatformAdapter = getPlatform(),
): EvalResult {
  const commands = input.command !== undefined ? variants(input.command, (s) => platform.normalizeCommand(s)) : [];
  const paths = input.path !== undefined ? variants(input.path, (s) => platform.normalizePath(s)) : [];
  for (const rule of rules) {
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, "i");
    } catch (e) {
      process.stderr.write(`cephalo: invalid pattern in rule ${rule.id}: ${(e as Error).message}\n`);
      continue;
    }
    if (rule.type === "command") {
      if (commands.some((c) => re.test(c))) return { decision: "block", rule };
    } else if (rule.type === "path") {
      if (paths.length === 0) continue;
      const on = rule.on ?? "any";
      const access = input.access ?? "read";
      if (on !== "any" && on !== access) continue;
      if (paths.some((p) => re.test(p))) return { decision: "block", rule };
    }
  }
  return { decision: "allow" };
}
