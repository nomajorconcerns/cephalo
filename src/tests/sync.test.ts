import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { DEFAULT_RULES } from "../rules.js";
import { applyPull, diffRules, loadSyncDir, planPull, publishAudit, pushPolicy, readTeamAudit, saveSyncDir } from "../sync/policy.js";
import { runDashboard, runSync } from "../synccmd.js";
import { buildDashboard } from "../dashboard/data.js";
import { renderDashboard } from "../dashboard/html.js";
import { evaluate } from "../engine.js";
import { SYSTEM_RULES } from "../platform-rules.js";
import type { AuditEntry } from "../audit.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cephalo-sync-"));
const rulesText = (extra: object[] = [], drop: string[] = []) => stringify({ rules: [...DEFAULT_RULES.filter((r) => !drop.includes(r.id)), ...extra] });
const NEW_RULE = { id: "no-prod-db", description: "Touching the prod database", type: "command", pattern: "prod-db", action: "block" };
const yes = { confirm: async () => true, yes: true };

test("push then pull: a hash-checked copy arrives, with a backup of the old file", async () => {
  const d = tmp(), shared = path.join(d, "shared"), cfg = path.join(d, "sync.yml");
  fs.mkdirSync(shared);
  const a = path.join(d, "a-rules.yml"), b = path.join(d, "b-rules.yml");
  fs.writeFileSync(a, rulesText([NEW_RULE]));
  fs.writeFileSync(b, rulesText());
  saveSyncDir(shared, cfg);
  assert.equal(loadSyncDir(cfg), shared);
  assert.equal((await runSync("push", undefined, { ...yes, configFile: cfg, rulesFile: a })).exitCode, 0);
  const plan = planPull(shared, b);
  assert.deepEqual(plan.diff!.added.map((r) => r.id), ["no-prod-db"]);
  const lines = applyPull(plan, b);
  assert.match(lines[0]!, /Backup:/);
  assert.match(fs.readFileSync(b, "utf8"), /no-prod-db/);
  assert.equal(planPull(shared, b).unchanged, true);
});

test("pull refuses a tampered file, a missing manifest and invalid rules; and says when rules would be removed", async () => {
  const d = tmp(), shared = path.join(d, "s"), mine = path.join(d, "mine.yml");
  fs.mkdirSync(shared);
  fs.writeFileSync(mine, rulesText([NEW_RULE]));
  assert.match(planPull(shared, mine).lines[0]!, /No shared policy/);
  fs.mkdirSync(path.join(shared, "policy"));
  fs.writeFileSync(path.join(shared, "policy", "rules.yml"), rulesText());
  assert.match(planPull(shared, mine).lines[0]!, /no MANIFEST/);
  const src = path.join(d, "src.yml");
  fs.writeFileSync(src, rulesText([], [DEFAULT_RULES[0]!.id]));
  assert.equal(pushPolicy(shared, src).ok, true);
  const plan = planPull(shared, mine);
  assert.ok(plan.ok);
  assert.ok(plan.lines.some((l) => /REMOVES\s+no-prod-db.*weaker/.test(l)));
  fs.appendFileSync(path.join(shared, "policy", "rules.yml"), "\n# edited later\n");
  assert.match(planPull(shared, mine).lines[0]!, /does not match its manifest/);
  const bad = path.join(d, "bad.yml");
  fs.writeFileSync(bad, "rules: [{id: x}]");
  assert.equal(pushPolicy(shared, bad).ok, false);
});

test("pull asks first: declining changes nothing", async () => {
  const d = tmp(), shared = path.join(d, "s"), cfg = path.join(d, "sync.yml"), mine = path.join(d, "m.yml"), src = path.join(d, "src.yml");
  fs.mkdirSync(shared);
  fs.writeFileSync(mine, rulesText());
  fs.writeFileSync(src, rulesText([NEW_RULE]));
  saveSyncDir(shared, cfg);
  pushPolicy(shared, src);
  const before = fs.readFileSync(mine, "utf8");
  const r = await runSync("pull", undefined, { confirm: async () => false, configFile: cfg, rulesFile: mine });
  assert.equal(r.exitCode, 1);
  assert.equal(fs.readFileSync(mine, "utf8"), before);
});

test("sync set needs an existing folder; status reports the state", async () => {
  const d = tmp(), cfg = path.join(d, "sync.yml");
  assert.equal((await runSync("set", path.join(d, "nope"), { ...yes, configFile: cfg })).exitCode, 1);
  assert.equal(fs.existsSync(cfg), false);
  assert.match((await runSync("status", undefined, { ...yes, configFile: cfg })).lines[0]!, /No shared folder/);
  assert.equal((await runSync("set", d, { ...yes, configFile: cfg })).exitCode, 0);
  assert.match((await runSync("status", undefined, { ...yes, configFile: cfg })).lines.join("\n"), /Shared policy: none published/);
});

test("diffRules finds added, removed and changed rules", () => {
  const a = DEFAULT_RULES.slice(0, 3);
  const b = [{ ...a[0]!, pattern: "changed" }, a[1]!, { ...NEW_RULE, type: "command" as const, action: "block" as const }];
  const d = diffRules(a, b);
  assert.deepEqual([d.added.length, d.removed.length, d.changed.length], [1, 1, 1]);
});

test("audit publishing keeps one file per developer; the team view merges them and names the user", async () => {
  const d = tmp(), shared = path.join(d, "s"), audit = path.join(d, "audit.jsonl");
  fs.mkdirSync(shared);
  const e = (o: Partial<AuditEntry>): AuditEntry => ({ ts: "2026-10-30T10:00:00Z", agent: "claude", tool: "Bash", decision: "allow", ...o });
  fs.writeFileSync(audit, [e({ command: "ls", user: "ann" }), e({ command: "rm -rf /", decision: "block", rule: "rm-rf", user: "ann" }), e({ ts: "2026-10-30T11:00:00Z" })].map((x) => JSON.stringify(x)).join("\n") + "\n");
  assert.equal(publishAudit(shared, audit, "ann@laptop.jsonl").entries, 3);
  fs.writeFileSync(path.join(shared, "audit", "bob@pc.jsonl"), JSON.stringify(e({ decision: "ask", ts: "2026-10-30T12:00:00Z" })) + "\nnot json\n");
  const team = readTeamAudit(shared);
  assert.equal(team.length, 4);
  assert.deepEqual(team.map((x) => x.user), ["ann", "ann", "ann@laptop", "bob@pc"]);
});

test("dashboard data counts calls, blocks and asks, ignores bookkeeping entries, and groups by user", () => {
  const now = new Date("2026-10-31T00:00:00Z");
  const e = (o: Partial<AuditEntry>): AuditEntry => ({ ts: "2026-10-30T10:00:00Z", agent: "claude", tool: "Bash", decision: "allow", user: "ann", ...o });
  const d = buildDashboard([e({}), e({ decision: "block", rule: "rm-rf", command: "rm -rf /" }), e({ decision: "ask", rule: "judge-ask" }), e({ rule: "judge-ask-approved" }), e({ tool: "models-check", rule: "models-missing" }), e({ rule: "tripwire-alert", note: "x" }), e({ ts: "2026-01-01T00:00:00Z" })], { source: "t", scope: "team folder", now });
  assert.deepEqual([d.totals.calls, d.totals.blocked, d.totals.asked, d.totals.tripwire], [4, 1, 1, 1]);
  assert.deepEqual(d.byRule, [{ rule: "rm-rf", count: 1 }]);
  assert.equal(d.byUser.ann!.calls, 4);
  assert.equal(d.byDay.length, 14);
});

test("dashboard page: self-contained, no network, and hostile text cannot break out of the data block", async () => {
  const d = tmp();
  const audit = path.join(d, "a.jsonl");
  const evil = '</script><img src=x onerror=alert(1)>';
  fs.writeFileSync(audit, JSON.stringify({ ts: new Date().toISOString(), agent: "claude", tool: "Bash", command: evil, decision: "block", rule: "r" }) + "\n");
  const r = await runDashboard({ cwd: d, auditFile: audit, noCost: true, out: "dash.html" });
  assert.equal(r.exitCode, 0);
  const html = fs.readFileSync(path.join(d, "dash.html"), "utf8");
  assert.match(html, /default-src 'none'/);
  assert.equal((html.match(/<\/script>/g) ?? []).length, 2, "only our own two script tags close");
  assert.ok(!html.includes(evil));
  assert.ok(!/https?:\/\//.test(html.replace(/<meta[^>]*>/g, "")), "no URLs to fetch");
  fs.writeFileSync(path.join(d, "other.html"), "<html>mine</html>");
  assert.equal((await runDashboard({ cwd: d, auditFile: audit, noCost: true, out: "other.html" })).exitCode, 1);
  assert.equal((await runDashboard({ cwd: d, auditFile: audit, noCost: true, out: "dash.html" })).exitCode, 0, "own file is replaced");
  assert.ok(renderDashboard(buildDashboard([], { source: "x", scope: "this machine" })).includes("Cephalo dashboard"));
});

test("dashboard reads the whole audit log, not just the last 20 entries", async () => {
  const d = tmp(), audit = path.join(d, "a.jsonl");
  const rows = Array.from({ length: 60 }, () => JSON.stringify({ ts: new Date().toISOString(), agent: "claude", tool: "Bash", command: "ls", decision: "allow" }));
  fs.writeFileSync(audit, rows.join("\n") + "\n");
  assert.match((await runDashboard({ cwd: d, auditFile: audit, noCost: true, out: "d.html" })).lines[1]!, /^60 calls/);
});

test("dashboard --team needs a shared folder with published logs", async () => {
  const d = tmp(), cfg = path.join(d, "sync.yml");
  assert.match((await runDashboard({ cwd: d, team: true, configFile: cfg })).lines[0]!, /No shared folder/);
  saveSyncDir(d, cfg);
  assert.match((await runDashboard({ cwd: d, team: true, configFile: cfg })).lines[0]!, /No published audit logs/);
});

test("agents cannot write sync.yml or prices.yml", () => {
  for (const p of ["C:/Users/zuri/.cephalo/sync.yml", "/home/u/.cephalo/prices.yml"]) assert.equal(evaluate({ path: p, access: "write" }, SYSTEM_RULES).rule?.id, "protect-cephalo-policy", p);
});
