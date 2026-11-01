import os from "node:os";
import type { AuditEntry } from "../audit.js";
import { redactTokens } from "../vault/patterns.js";

export type EventKind = "call" | "block" | "tripwire" | "leak" | "vault" | "mcp";

export interface ReplayEvent {
  n: number;
  ts: string;
  agent: string;
  user?: string;
  session?: string;
  tool: string;
  kind: EventKind;
  decision: "allow" | "block";
  /** Cephalo had the user approve this call first (the entry's decision was "ask"). */
  asked?: boolean;
  rule?: string;
  /** What the call acted on: the command, the path, or a short form of the MCP parameters. */
  subject: string;
  note?: string;
  server?: string;
  pin?: string;
  /** A tool that changes files. */
  write?: boolean;
}

export interface ReplayMeta {
  generatedAt: string;
  version: string;
  repo?: { root?: string; branch?: string; base?: string; head?: string; remote?: string };
  pr?: { number: number; url?: string };
  window: { since?: string; until?: string; basis: string };
  /** Things a reader should know about how this replay was assembled. */
  notes: string[];
}

export interface ReplayStats {
  /** Every log entry in the window. */
  total: number;
  /** Tool calls: `total` minus the injection and credential observations, which describe a call that has its own entry. */
  calls: number;
  blocked: number;
  byRule: Record<string, number>;
  tripwire: { alert: number; watch: number };
  leaks: number;
  vault: { runs: number; refused: number; names: string[] };
  mcp: { calls: number; blocked: number; servers: string[] };
  tools: Record<string, number>;
  agents: string[];
  users: string[];
  sessions: number;
  first?: string;
  last?: string;
  durationMs: number;
  commands: number;
  filesWritten: string[];
}

export interface Replay {
  meta: ReplayMeta;
  stats: ReplayStats;
  events: ReplayEvent[];
}

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "write_file", "patch"]);
const COMMAND_TOOLS = new Set(["Bash", "terminal", "execute_code"]);
const MAX_SUBJECT = 600;

/** Show the home directory as ~ so a replay pasted into a PR does not carry the user's profile path. */
export function shortenHome(text: string, home: string = os.homedir()): string {
  if (!home) return text;
  const variants = new Set([home, home.replace(/\\/g, "/"), home.replace(/\//g, "\\")]);
  let out = text;
  for (const v of variants) {
    const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // also match the JSON-escaped form (double backslashes)
    out = out.replace(new RegExp(esc.replace(/\\\\/g, "\\\\\\\\"), "gi"), "~");
    out = out.replace(new RegExp(esc, "gi"), "~");
  }
  return out;
}

const clean = (s: string, max = MAX_SUBJECT) => {
  const one = shortenHome(redactTokens(s)).replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
};

function subjectOf(e: AuditEntry): string {
  if (e.command !== undefined) return clean(e.command);
  if (e.path !== undefined) return clean(e.path);
  if (e.params !== undefined) return clean(typeof e.params === "string" ? e.params : JSON.stringify(e.params));
  return "";
}

export function kindOf(e: AuditEntry): EventKind {
  if (e.rule?.startsWith("tripwire-")) return "tripwire";
  if (e.rule === "secret-in-output") return "leak";
  if (e.tool === "vault-run") return "vault";
  if (e.decision === "block") return "block";
  if (e.server || e.tool.startsWith("mcp")) return "mcp";
  return "call";
}

export function toEvents(entries: AuditEntry[]): ReplayEvent[] {
  return entries.map((e, i) => ({
    n: i + 1,
    ts: e.ts,
    agent: e.agent,
    ...(e.user ? { user: e.user } : {}),
    ...(e.session ? { session: e.session } : {}),
    tool: e.tool,
    kind: kindOf(e),
    decision: e.decision === "block" ? "block" : "allow",
    ...(e.decision === "ask" ? { asked: true } : {}),
    ...(e.rule ? { rule: e.rule } : {}),
    subject: subjectOf(e),
    ...(e.note ? { note: clean(e.note, 400) } : {}),
    ...(e.server ? { server: e.server } : {}),
    ...(e.pin ? { pin: e.pin } : {}),
    ...(WRITE_TOOLS.has(e.tool) ? { write: true } : {}),
  }));
}

export function statsOf(events: ReplayEvent[]): ReplayStats {
  const byRule: Record<string, number> = {};
  const tools: Record<string, number> = {};
  const agents = new Set<string>();
  const users = new Set<string>();
  const sessions = new Set<string>();
  const servers = new Set<string>();
  const vaultNames = new Set<string>();
  const files = new Set<string>();
  const s: ReplayStats = {
    total: events.length,
    calls: events.filter((e) => e.kind !== "tripwire" && e.kind !== "leak").length,
    blocked: 0,
    byRule,
    tripwire: { alert: 0, watch: 0 },
    leaks: 0,
    vault: { runs: 0, refused: 0, names: [] },
    mcp: { calls: 0, blocked: 0, servers: [] },
    tools,
    agents: [],
    users: [],
    sessions: 0,
    durationMs: 0,
    commands: 0,
    filesWritten: [],
  };
  for (const e of events) {
    tools[e.tool] = (tools[e.tool] ?? 0) + 1;
    agents.add(e.agent);
    if (e.user) users.add(e.user);
    if (e.session) sessions.add(`${e.agent}:${e.session}`);
    if (e.decision === "block") {
      s.blocked++;
      if (e.rule) byRule[e.rule] = (byRule[e.rule] ?? 0) + 1;
    }
    if (e.kind === "tripwire") e.rule === "tripwire-alert" ? s.tripwire.alert++ : s.tripwire.watch++;
    if (e.kind === "leak") s.leaks++;
    if (e.kind === "vault") {
      s.vault.runs++;
      if (e.decision === "block") s.vault.refused++;
      const m = /injected ([A-Za-z0-9_, ]+);/.exec(e.note ?? "");
      for (const n of m?.[1].split(",") ?? []) if (n.trim()) vaultNames.add(n.trim());
    }
    if (e.server || e.tool.startsWith("mcp")) {
      s.mcp.calls++;
      if (e.decision === "block") s.mcp.blocked++;
      if (e.server) servers.add(e.server);
    }
    if (COMMAND_TOOLS.has(e.tool) && e.kind !== "tripwire" && e.kind !== "leak") s.commands++;
    if (e.write && e.decision === "allow" && e.subject) files.add(e.subject);
  }
  s.agents = [...agents].sort();
  s.users = [...users].sort();
  s.sessions = sessions.size;
  s.vault.names = [...vaultNames].sort();
  s.mcp.servers = [...servers].sort();
  s.filesWritten = [...files].sort().slice(0, 200);
  s.first = events[0]?.ts;
  s.last = events.at(-1)?.ts;
  s.durationMs = s.first && s.last ? Math.max(0, Date.parse(s.last) - Date.parse(s.first)) : 0;
  return s;
}

/** Events a reviewer should look at first. */
export const needsAttention = (e: ReplayEvent) => e.decision === "block" || !!e.asked || e.kind === "tripwire" || e.kind === "leak";

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
