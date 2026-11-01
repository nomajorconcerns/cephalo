import { loadPrices } from "../cost/prices.js";
import { classify, ghLookup, type PrLookup, type Shipped } from "../cost/ship.js";
import { readClaudeSessions, readHermesSessions, type SessionCost } from "../cost/usage.js";
import type { Replay } from "./model.js";

/** What a shared replay file carries besides the replay itself: what the work cost and how it ended. */
export interface Bundle {
  /** When the cost and outcome were looked up. The outcome can change later (a PR gets merged). */
  checkedAt: string;
  outcome: { status: Shipped["status"] | "not-checked"; pr?: { number: number; url?: string }; branch?: string; basis: string };
  cost: {
    sessions: Array<{ agent: string; id: string; models: string[]; usd: number | null; partial?: boolean; basis: SessionCost["basis"]; tokens: SessionCost["tokens"]; matchedBy: "session id" | "time and directory" }>;
    totalUsd: number | null;
    note: string;
  };
}

export interface BundleEnv {
  now?: Date;
  lookup?: PrLookup;
  noGithub?: boolean;
  claudeDir?: string;
  hermesDb?: string;
  pricesFile?: string;
  cwd?: string;
}

const norm = (p: string) => p.split("\\").join("/").replace(/\/+$/, "").toLowerCase();
const within = (cwd: string | undefined, root: string | undefined) => !!cwd && !!root && (norm(cwd) === norm(root) || norm(cwd).startsWith(norm(root) + "/"));

export async function buildBundle(r: Replay, env: BundleEnv = {}): Promise<Bundle> {
  const now = env.now ?? new Date();
  const ids = new Set(r.events.map((e) => e.session).filter((s): s is string => !!s));
  const first = r.stats.first ? new Date(r.stats.first) : now;
  const last = r.stats.last ? new Date(r.stats.last) : now;
  const since = new Date(first.getTime() - 86_400_000);
  const { prices } = loadPrices(env.pricesFile);
  const matched: Bundle["cost"]["sessions"] = [];
  const add = (s: SessionCost, by: "session id" | "time and directory") =>
    matched.push({ agent: s.agent, id: s.id, models: s.models, usd: s.usd, ...(s.partial ? { partial: true } : {}), basis: s.basis, tokens: s.tokens, matchedBy: by });
  for (const s of readClaudeSessions(since, prices, env.claudeDir)) if (ids.has(s.id)) add(s, "session id");
  // Hermes' audit entries carry no session id, so its sessions are matched by overlapping in time inside the project.
  if (r.stats.agents.includes("hermes")) {
    for (const s of await readHermesSessions(since, env.hermesDb)) {
      if (!within(s.cwd, r.meta.repo?.root ?? env.cwd)) continue;
      if (new Date(s.end) >= first && new Date(s.start) <= last) add(s, "time and directory");
    }
  }
  const priced = matched.filter((m) => m.usd !== null);
  const totalUsd = priced.length ? priced.reduce((a, m) => a + (m.usd ?? 0), 0) : null;
  const notes: string[] = [];
  if (!matched.length) notes.push("No token usage was found for the sessions in this replay (Claude Code transcripts or Hermes records may be missing or out of range).");
  if (matched.some((m) => m.basis === "list-price estimate")) notes.push("Claude Code dollars are an estimate: token counts times Anthropic's API list prices. A subscription is a flat fee, so this is not what was charged.");
  if (matched.some((m) => m.usd === null || m.partial)) notes.push("Some usage has no known price, so the total is a lower bound.");
  if (matched.some((m) => m.matchedBy === "time and directory")) notes.push("Hermes sessions are matched by time and project directory, not by id, so a parallel session could be included.");

  const branch = r.meta.repo?.branch;
  const cwd = r.meta.repo?.root ?? env.cwd;
  let outcome: Bundle["outcome"];
  if (env.noGithub) outcome = { status: "not-checked", ...(branch ? { branch } : {}), basis: "GitHub was not queried (--no-github)." };
  else if (!branch || !cwd) outcome = { status: "no-branch", basis: "The replay has no git branch to look up." };
  else {
    const sh = classify((env.lookup ?? ghLookup)(cwd, branch));
    outcome = { status: sh.status, branch, ...(sh.pr ? { pr: { number: sh.pr.number, ...(sh.pr.url ? { url: sh.pr.url } : {}) } } : {}), basis: "Shipped means a merged pull request with passing CI on its head commit, looked up with gh at the time shown." };
  }
  return { checkedAt: now.toISOString(), outcome, cost: { sessions: matched, totalUsd, note: notes.join(" ") } };
}
