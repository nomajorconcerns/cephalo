import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NO_TOKENS, addTokens, costOf, priceFor, type Price, type Tokens } from "./prices.js";

export interface SessionCost {
  agent: "claude" | "hermes";
  id: string;
  cwd?: string;
  branch?: string;
  start: string;
  end: string;
  models: string[];
  tokens: Tokens;
  /** Estimated US dollars; null when no token of this session could be priced. */
  usd: number | null;
  /** Some models in this session have no price, so usd is a lower bound. */
  partial?: boolean;
  /** Where the dollar figure came from. */
  basis: "list-price estimate" | "reported by Hermes" | "estimated by Hermes" | "unpriced";
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function claudeProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/** Read one Claude Code transcript (JSONL). Streaming writes the same message several times; the last copy per message id wins. */
export function readClaudeTranscript(file: string, prices: Record<string, Price>): SessionCost | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const byMsg = new Map<string, { model: string; t: Tokens }>();
  let id: string | undefined, cwd: string | undefined, branch: string | undefined, start = "", end = "";
  for (const line of text.split("\n")) {
    if (!line.includes('"usage"') && !line.includes('"sessionId"')) continue;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof j?.sessionId === "string") id ??= j.sessionId;
    if (typeof j?.cwd === "string") cwd ??= j.cwd;
    if (typeof j?.gitBranch === "string" && j.gitBranch) branch = j.gitBranch;
    const ts = typeof j?.timestamp === "string" ? j.timestamp : "";
    if (ts) {
      if (!start || ts < start) start = ts;
      if (ts > end) end = ts;
    }
    const m = j?.message;
    const u = m?.usage;
    if (!u || typeof u !== "object" || m.model === "<synthetic>") continue;
    const key = String(m.id ?? j.requestId ?? j.uuid ?? byMsg.size);
    byMsg.set(key, { model: String(m.model ?? "unknown"), t: { input: n(u.input_tokens), output: n(u.output_tokens), cacheWrite: n(u.cache_creation_input_tokens), cacheRead: n(u.cache_read_input_tokens) } });
  }
  if (byMsg.size === 0) return null;
  let tokens = NO_TOKENS;
  let usd = 0;
  let priced = 0;
  let unpriced = 0;
  const models = new Set<string>();
  for (const { model, t } of byMsg.values()) {
    models.add(model);
    tokens = addTokens(tokens, t);
    const p = priceFor(model, prices);
    if (p) {
      usd += costOf(t, p);
      priced++;
    } else unpriced++;
  }
  return {
    agent: "claude",
    id: id ?? path.basename(file, ".jsonl"),
    ...(cwd ? { cwd } : {}),
    ...(branch ? { branch } : {}),
    start,
    end,
    models: [...models],
    tokens,
    usd: priced ? usd : null,
    ...(priced && unpriced ? { partial: true } : {}),
    basis: priced ? "list-price estimate" : "unpriced",
  };
}

export function readClaudeSessions(since: Date, prices: Record<string, Price>, dir = claudeProjectsDir()): SessionCost[] {
  const out: SessionCost[] = [];
  let projects: string[] = [];
  try {
    projects = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const p of projects) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(path.join(dir, p)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const full = path.join(dir, p, f);
      try {
        if (fs.statSync(full).mtime < since) continue;
      } catch {
        continue;
      }
      const s = readClaudeTranscript(full, prices);
      if (s && new Date(s.end) >= since) out.push(s);
    }
  }
  return out;
}

export function hermesDbPath(): string {
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return process.platform === "win32" ? path.join(base, "hermes", "state.db") : path.join(os.homedir(), ".hermes", "state.db");
}

const iso = (v: unknown) => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) && x > 0 ? new Date(x < 1e12 ? x * 1000 : x).toISOString() : "";
};

/** Hermes keeps its own token counts and a cost in its SQLite state. Read-only. Missing file or no SQLite support = no sessions. */
export async function readHermesSessions(since: Date, file = hermesDbPath()): Promise<SessionCost[]> {
  if (!fs.existsSync(file)) return [];
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT id, model, started_at, ended_at, last_activity_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cwd, git_branch, estimated_cost_usd, actual_cost_usd FROM sessions WHERE COALESCE(input_tokens,0)+COALESCE(output_tokens,0) > 0")
        .all() as any[];
      const out: SessionCost[] = [];
      for (const r of rows) {
        const end = iso(r.ended_at) || iso(r.last_activity_at) || iso(r.started_at);
        if (!end || new Date(end) < since) continue;
        const actual = typeof r.actual_cost_usd === "number" ? r.actual_cost_usd : null;
        const est = typeof r.estimated_cost_usd === "number" ? r.estimated_cost_usd : null;
        const usd = actual ?? est;
        out.push({
          agent: "hermes",
          id: String(r.id),
          ...(r.cwd ? { cwd: String(r.cwd) } : {}),
          ...(r.git_branch ? { branch: String(r.git_branch) } : {}),
          start: iso(r.started_at) || end,
          end,
          models: r.model ? [String(r.model)] : [],
          tokens: { input: n(r.input_tokens), output: n(r.output_tokens), cacheWrite: n(r.cache_write_tokens), cacheRead: n(r.cache_read_tokens) },
          usd,
          basis: actual !== null ? "reported by Hermes" : est !== null ? "estimated by Hermes" : "unpriced",
        });
      }
      return out;
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}
