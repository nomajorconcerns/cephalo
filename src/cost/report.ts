import type { ShipStatus, Shipped } from "./ship.js";
import type { SessionCost } from "./usage.js";

export interface CostReport {
  since: string;
  sessions: number;
  totalUsd: number;
  /** Sessions with no price at all (their tokens are counted, their dollars are not). */
  unpricedSessions: number;
  tokens: { input: number; output: number; cacheWrite: number; cacheRead: number };
  /** Distinct pull requests that were merged with passing CI. */
  shippedResults: number;
  shippedUsd: number;
  /** Dollars spent on sessions that did not end in a shipped result. */
  otherUsd: number;
  /** totalUsd / shippedResults; null when nothing shipped. */
  costPerShipped: number | null;
  byStatus: Partial<Record<ShipStatus, { sessions: number; usd: number }>>;
  rows: Array<{ agent: string; id: string; branch?: string; end: string; usd: number | null; partial?: boolean; status: ShipStatus; pr?: number }>;
  notes: string[];
}

export function buildCostReport(sessions: SessionCost[], ship: Map<SessionCost, Shipped>, since: Date): CostReport {
  const byStatus: CostReport["byStatus"] = {};
  const prs = new Set<string>();
  let totalUsd = 0, shippedUsd = 0, unpriced = 0;
  const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const rows: CostReport["rows"] = [];
  for (const s of sessions) {
    const sh = ship.get(s) ?? { status: "unknown" as const };
    totalUsd += s.usd ?? 0;
    if (s.usd === null) unpriced++;
    for (const k of Object.keys(tokens) as Array<keyof typeof tokens>) tokens[k] += s.tokens[k];
    const b = (byStatus[sh.status] ??= { sessions: 0, usd: 0 });
    b.sessions++;
    b.usd += s.usd ?? 0;
    if (sh.status === "shipped" && sh.pr) {
      prs.add(`${s.cwd}#${sh.pr.number}`);
      shippedUsd += s.usd ?? 0;
    }
    rows.push({ agent: s.agent, id: s.id, ...(s.branch ? { branch: s.branch } : {}), end: s.end, usd: s.usd, ...(s.partial ? { partial: true } : {}), status: sh.status, ...(sh.pr ? { pr: sh.pr.number } : {}) });
  }
  rows.sort((a, b) => b.end.localeCompare(a.end));
  const notes: string[] = [];
  if (sessions.some((s) => s.basis === "list-price estimate")) notes.push("Dollar figures for Claude Code are an estimate: token counts times Anthropic's API list prices. A subscription plan is a flat fee, so this is not what you were charged.");
  if (unpriced) notes.push(`${unpriced} session(s) use a model with no price, so their dollars are missing. Add the model to ~/.cephalo/prices.yml.`);
  if (sessions.some((s) => s.partial)) notes.push("Some sessions mix priced and unpriced models; their dollars are a lower bound.");
  if ((byStatus.unknown?.sessions ?? 0) > 0) notes.push(`${byStatus.unknown!.sessions} session(s) could not be checked against GitHub (gh missing, offline, or not a GitHub repo), so they are not counted as shipped.`);
  if ((byStatus["merged-no-ci"]?.sessions ?? 0) > 0) notes.push(`${byStatus["merged-no-ci"]!.sessions} session(s) reached a merged PR that has no CI checks. "Shipped" requires passing CI, so they are not counted.`);
  return {
    since: since.toISOString(),
    sessions: sessions.length,
    totalUsd,
    unpricedSessions: unpriced,
    tokens,
    shippedResults: prs.size,
    shippedUsd,
    otherUsd: totalUsd - shippedUsd,
    costPerShipped: prs.size ? totalUsd / prs.size : null,
    byStatus,
    rows,
    notes,
  };
}

const usd = (v: number | null) => (v === null ? "n/a" : `$${v.toFixed(2)}`);
const mtok = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : String(v));

export function formatCostReport(r: CostReport, opts: { rows?: number } = {}): string[] {
  const l: string[] = [];
  l.push(`Cost since ${r.since.slice(0, 10)}: ${r.sessions} session(s), about ${usd(r.totalUsd)} (estimate)`);
  l.push(`Tokens: ${mtok(r.tokens.input)} in, ${mtok(r.tokens.output)} out, ${mtok(r.tokens.cacheWrite)} cache writes, ${mtok(r.tokens.cacheRead)} cache reads`);
  l.push("");
  l.push(r.costPerShipped === null ? "Cost per shipped result: n/a (no session reached a merged PR with passing CI)" : `Cost per shipped result: ${usd(r.costPerShipped)}  (${r.shippedResults} merged PR(s) with passing CI)`);
  l.push(`  spent on sessions that shipped: ${usd(r.shippedUsd)}`);
  l.push(`  spent on everything else:       ${usd(r.otherUsd)}${r.totalUsd ? ` (${Math.round((100 * r.otherUsd) / r.totalUsd)}%)` : ""}`);
  l.push("");
  l.push("By outcome:");
  for (const [k, v] of Object.entries(r.byStatus).sort((a, b) => b[1]!.usd - a[1]!.usd)) l.push(`  ${k.padEnd(17)} ${String(v!.sessions).padStart(3)} session(s)  ${usd(v!.usd)}`);
  const max = opts.rows ?? 10;
  if (max > 0 && r.rows.length) {
    l.push("", `Latest sessions (${Math.min(max, r.rows.length)} of ${r.rows.length}):`);
    for (const s of r.rows.slice(0, max)) l.push(`  ${s.end.slice(0, 16).replace("T", " ")}  ${s.agent.padEnd(6)} ${usd(s.usd).padStart(8)}${s.partial ? "+" : " "} ${s.status.padEnd(16)} ${s.pr ? `#${s.pr} ` : ""}${s.branch ?? ""}`);
  }
  if (r.notes.length) l.push("", ...r.notes.map((n) => `Note: ${n}`));
  return l;
}
