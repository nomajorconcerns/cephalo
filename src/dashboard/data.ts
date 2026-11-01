import { entrySubject, type AuditEntry } from "../audit.js";
import type { CostReport } from "../cost/report.js";

export interface DashboardData {
  generated: string;
  source: string;
  scope: "this machine" | "team folder";
  totals: { calls: number; allowed: number; blocked: number; asked: number; tripwire: number; secretsInOutput: number; modelCalls: number };
  byAgent: Record<string, number>;
  byUser: Record<string, { calls: number; blocked: number; asked: number }>;
  byRule: Array<{ rule: string; count: number }>;
  byDay: Array<{ day: string; calls: number; blocked: number; asked: number }>;
  attention: Array<{ ts: string; agent: string; user?: string; tool: string; decision: string; rule?: string; subject: string }>;
  cost?: CostReport;
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/** Counts for the dashboard. Pure; the audit entries decide everything, so a team view is the same code over more entries. */
export function buildDashboard(entries: AuditEntry[], o: { source: string; scope: DashboardData["scope"]; days?: number; now?: Date; cost?: CostReport }): DashboardData {
  const now = o.now ?? new Date();
  const days = o.days ?? 14;
  const from = new Date(now.getTime() - days * 86_400_000).toISOString();
  const es = entries.filter((e) => e.ts >= from && e.tool !== "models-check");
  const byAgent: DashboardData["byAgent"] = {};
  const byUser: DashboardData["byUser"] = {};
  const rules = new Map<string, number>();
  const dayMap = new Map<string, { calls: number; blocked: number; asked: number }>();
  for (let i = days - 1; i >= 0; i--) dayMap.set(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10), { calls: 0, blocked: 0, asked: 0 });
  const t = { calls: 0, allowed: 0, blocked: 0, asked: 0, tripwire: 0, secretsInOutput: 0, modelCalls: 0 };
  const attention: DashboardData["attention"] = [];
  for (const e of es) {
    const note = e.rule ?? "";
    const isEvent = note.startsWith("tripwire-") || note === "secret-in-output" || note.startsWith("judge-ask-") || note.startsWith("models-");
    if (note.startsWith("tripwire-")) t.tripwire++;
    if (note === "secret-in-output") t.secretsInOutput++;
    if (e.model) t.modelCalls++;
    if (isEvent && e.decision === "allow" && !note.startsWith("tripwire-") && note !== "secret-in-output") continue; // bookkeeping entries are not calls
    t.calls++;
    byAgent[e.agent] = (byAgent[e.agent] ?? 0) + 1;
    const u = (byUser[e.user ?? "unknown"] ??= { calls: 0, blocked: 0, asked: 0 });
    u.calls++;
    const d = dayMap.get(e.ts.slice(0, 10));
    if (d) d.calls++;
    if (e.decision === "block") {
      t.blocked++;
      u.blocked++;
      if (d) d.blocked++;
      if (e.rule) rules.set(e.rule, (rules.get(e.rule) ?? 0) + 1);
    } else if (e.decision === "ask") {
      t.asked++;
      u.asked++;
      if (d) d.asked++;
    } else t.allowed++;
    if (e.decision !== "allow" || note.startsWith("tripwire-") || note === "secret-in-output") {
      attention.push({ ts: e.ts, agent: e.agent, ...(e.user ? { user: e.user } : {}), tool: e.tool, decision: e.decision, ...(e.rule ? { rule: e.rule } : {}), subject: cut(entrySubject(e).replace(/\s+/g, " "), 160) });
    }
  }
  return {
    generated: now.toISOString(),
    source: o.source,
    scope: o.scope,
    totals: t,
    byAgent,
    byUser,
    byRule: [...rules].map(([rule, count]) => ({ rule, count })).sort((a, b) => b.count - a.count).slice(0, 10),
    byDay: [...dayMap].map(([day, v]) => ({ day, ...v })),
    attention: attention.slice(-40).reverse(),
    ...(o.cost ? { cost: o.cost } : {}),
  };
}
