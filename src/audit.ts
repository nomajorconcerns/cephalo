import fs from "node:fs";
import path from "node:path";
import { cephaloDir } from "./rules.js";

export interface AuditEntry {
  ts: string;
  agent: string;
  tool: string;
  command?: string;
  path?: string;
  decision: "allow" | "block";
  rule?: string;
  error?: string;
}

export function auditPath(): string {
  return path.join(cephaloDir(), "audit.jsonl");
}

export function appendAudit(entry: AuditEntry, file: string = auditPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
}

export function readAudit(
  opts: { blocked?: boolean; limit?: number } = {},
  file: string = auditPath(),
): AuditEntry[] {
  if (!fs.existsSync(file)) return [];
  const entries: AuditEntry[] = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      /* skip corrupt line */
    }
  }
  const filtered = opts.blocked ? entries.filter((e) => e.decision === "block") : entries;
  const limit = opts.limit ?? 20;
  return limit > 0 ? filtered.slice(-limit) : filtered;
}

export function formatAudit(e: AuditEntry): string {
  const what = e.command ?? e.path ?? "";
  const rule = e.rule ? ` [${e.rule}]` : "";
  const err = e.error ? ` (error: ${e.error})` : "";
  return `${e.ts}  ${e.decision.toUpperCase().padEnd(5)}  ${e.agent}/${e.tool}${rule}  ${what}${err}`;
}
