import { entrySubject, formatAudit, shadowLabel, type AuditEntry } from "./audit.js";
import type { Painter } from "./theme.js";

/**
 * Colored versions of the CLI's lines. With no color (a pipe, NO_COLOR) each one is exactly the plain text, so
 * scripts that read `cephalo log` see the same thing as before. The words ALLOW, BLOCK and ASK are always present.
 */

const kindOf = (d: AuditEntry["decision"]): "allow" | "block" | "ask" => (d === "block" ? "block" : d === "ask" ? "ask" : "allow");

/** One `cephalo log` line. */
export function formatAuditColored(e: AuditEntry, p: Painter): string {
  if (p.level === 0) return formatAudit(e);
  const word = e.decision.toUpperCase();
  const label = p.label(kindOf(e.decision), word) + " ".repeat(Math.max(0, 5 - word.length));
  const rule = e.rule ? ` ${p.role("accent", `[${e.rule}]`)}` : "";
  const shadow = shadowLabel(e) ? ` ${p.role("shadow", `{${shadowLabel(e)}}`)}` : "";
  const err = e.error ? ` ${p.role("dim", `(error: ${e.error})`)}` : "";
  const who = e.user ? `  ${p.role("dim", `(${e.user})`)}` : "";
  return `${p.role("dim", e.ts)}  ${label}  ${e.agent}/${e.tool}${rule}${shadow}  ${entrySubject(e)}${err}${who}`;
}

/** The answer of `cephalo test`. */
export function formatVerdict(
  res: { decision: "allow" | "block" | "ask"; rule?: { id: string; description: string }; shadow?: Array<{ rule: { id: string; description: string }; would: "block" | "ask" }> },
  p: Painter,
  askDefault: string,
): string[] {
  const lines: string[] = [];
  if (res.decision === "block" && res.rule) lines.push(`${p.label("block", "🛑 BLOCKED")} (${res.rule.id}: ${res.rule.description})`);
  else if (res.decision === "ask" && res.rule) lines.push(`${p.label("ask", "? ASK")} (${res.rule.id}: ${res.rule.description}) - Claude Code asks you; agents that cannot ask follow ask-default (${askDefault})`);
  else lines.push(p.label("allow", "✓ ALLOWED"));
  for (const s of res.shadow ?? []) lines.push(`  ${p.role("shadow", `would ${s.would} (shadow mode)`)}: ${s.rule.id} - ${s.rule.description}`);
  return lines;
}

/** A question put to the user ("Apply? [y/N] "). */
export function promptStyle(p: Painter, question: string): string {
  return p.level === 0 ? question : p.role("prompt", question);
}
