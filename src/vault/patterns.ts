/**
 * Shapes of well-known credentials. Used two ways:
 *  - before a command runs: a literal token in a command line is refused (it would sit in the agent's context and shell history);
 *  - after a tool returned: a token in the output means it is now in the agent's context and should be treated as exposed.
 * Heuristics: they only know the formats below, and an attacker can obfuscate.
 */
export interface TokenPattern {
  type: string;
  re: string;
}

export const TOKEN_PATTERNS: TokenPattern[] = [
  { type: "GitHub token", re: "\\bgh[pousr]_[A-Za-z0-9]{36,}\\b" },
  { type: "GitHub fine-grained token", re: "\\bgithub_pat_[A-Za-z0-9_]{50,}\\b" },
  { type: "Anthropic API key", re: "\\bsk-ant-[A-Za-z0-9_-]{30,}" },
  { type: "OpenAI API key", re: "\\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}" },
  { type: "AWS access key id", re: "\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b" },
  { type: "Slack token", re: "\\bxox[baprs]-[A-Za-z0-9-]{10,}" },
  { type: "Google API key", re: "\\bAIza[0-9A-Za-z_-]{35}\\b" },
  { type: "GitLab token", re: "\\bglpat-[A-Za-z0-9_-]{20,}" },
  { type: "npm token", re: "\\bnpm_[A-Za-z0-9]{36}\\b" },
  { type: "Stripe key", re: "\\b[rs]k_live_[A-Za-z0-9]{24,}" },
  { type: "Private key", re: "-----BEGIN [A-Z ]*PRIVATE KEY-----" },
  { type: "JSON Web Token", re: "\\beyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}" },
];

/** One regex source matching any of the known formats (for the rule engine). */
export const ANY_TOKEN_SOURCE = TOKEN_PATTERNS.map((p) => `(?:${p.re})`).join("|");

/** Replace every known token format in `text` with [REDACTED:<type>]. */
export function redactTokens(text: string): string {
  let out = text;
  for (const p of TOKEN_PATTERNS) out = out.replace(new RegExp(p.re, "g"), `[REDACTED:${p.type}]`);
  return out;
}

export interface Leak {
  type: string;
  /** First characters only, plus the length. Never the whole value. */
  preview: string;
}

export function findLeaks(text: string, max = 5): Leak[] {
  const out: Leak[] = [];
  const seen = new Set<string>();
  for (const p of TOKEN_PATTERNS) {
    const m = new RegExp(p.re).exec(text);
    if (!m || seen.has(p.type)) continue;
    seen.add(p.type);
    out.push({ type: p.type, preview: `${m[0].slice(0, 4)}… (${m[0].length} chars)` });
    if (out.length >= max) break;
  }
  return out;
}
