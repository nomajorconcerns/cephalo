import fs from "node:fs";
import path from "node:path";
import { cephaloDir } from "./rules.js";
import { redactTokens } from "./vault/patterns.js";

/** One question put to a local model. `verdict` is the model's answer, or "no-answer" when nothing usable came back. */
export interface ModelEvent {
  role: "decider" | "reviewer" | "embedding";
  /** The model that answered; when none did, the models that were tried, joined with "+". */
  name: string;
  verdict: string;
  /** Probability from a decision model (0..1), when it gave one. */
  p?: number;
  ms: number;
  cached: boolean;
  signals?: string[];
}

export interface AuditEntry {
  ts: string;
  agent: string;
  tool: string;
  command?: string;
  path?: string;
  /** "ask" = the agent was told to get the user's approval first (Claude Code only; see judge/apply.ts). */
  decision: "allow" | "block" | "ask";
  rule?: string;
  /** What a local model said about this call (structured, so thresholds can be tuned from the log). */
  model?: ModelEvent;
  error?: string;
  /** OS account that ran the agent. */
  user?: string;
  /** MCP calls: configured server name, what it runs / where it is, and the (redacted) parameters. */
  server?: string;
  serverId?: string;
  /** Fingerprint of the approved tool set when the call was made (short form), if the server is pinned. */
  pin?: string;
  params?: unknown;
  note?: string;
  /** The agent's session id and working directory (what lets a replay be scoped to one project/branch). */
  session?: string;
  cwd?: string;
}

/** Short text describing what the call acted on, for one-line views. */
export function entrySubject(e: AuditEntry): string {
  if (e.command !== undefined) return e.command;
  if (e.path !== undefined) return e.path;
  if (e.params !== undefined) {
    const s = typeof e.params === "string" ? e.params : JSON.stringify(e.params);
    return s.length > 300 ? `${s.slice(0, 300)}…` : s;
  }
  return "";
}

export function auditPath(): string {
  return path.join(cephaloDir(), "audit.jsonl");
}

export function appendAudit(entry: AuditEntry, file: string = auditPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A command that carried a literal token (and was blocked for it) must not leave that token in the log.
  fs.appendFileSync(file, redactTokens(JSON.stringify(entry)) + "\n", "utf8");
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
  const what = entrySubject(e);
  const rule = e.rule ? ` [${e.rule}]` : "";
  const err = e.error ? ` (error: ${e.error})` : "";
  const who = e.user ? `  (${e.user})` : "";
  return `${e.ts}  ${e.decision.toUpperCase().padEnd(5)}  ${e.agent}/${e.tool}${rule}  ${what}${err}${who}`;
}
