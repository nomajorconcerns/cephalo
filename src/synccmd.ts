import fs from "node:fs";
import path from "node:path";
import { auditPath, readAudit } from "./audit.js";
import { buildDashboard } from "./dashboard/data.js";
import { renderDashboard } from "./dashboard/html.js";
import { costReport } from "./costcmd.js";
import { defaultRulesPath } from "./rules.js";
import { applyPull, loadSyncDir, planPull, publishAudit, pushPolicy, readManifest, readTeamAudit, saveSyncDir, syncConfigPath } from "./sync/policy.js";
import { SIGNING_KEY_FILE, TRUST_FILE, addTrusted, generateKeypair, keyId, loadTrusted } from "./sync/sign.js";

export interface SyncOptions {
  /** Ask the user to confirm a change. Called only when a file is about to be written. */
  confirm: (question: string) => Promise<boolean>;
  yes?: boolean;
  configFile?: string;
  rulesFile?: string;
  auditFile?: string;
}

export const SYNC_USAGE = `Usage: cephalo sync [status | set <folder> | push | pull | audit | keygen | trust <public-key-file>]

Share policy and the audit log through a folder you already have: a synced drive, a network share, or a clone of a git repo.
Cephalo only reads and writes files in that folder; it sends nothing anywhere itself.
  set <folder>   choose the shared folder (asks first)
  push           publish your rules.yml to <folder>/policy (asks first)
  pull           show what the shared rules would change, then apply them (asks first, backs up first)
  audit          publish your audit log to <folder>/audit/<user>@<machine>.jsonl (asks first)
  keygen         (admin) create a signing key pair next to sync.yml; push then signs the policy
  trust <file>   (developer) trust an admin's public key; pull then refuses unsigned or wrongly signed policy
Add --yes to skip the question.`;

async function confirmed(o: SyncOptions, question: string): Promise<boolean> {
  return o.yes ? true : o.confirm(question);
}

export async function runSync(sub: string, arg: string | undefined, o: SyncOptions): Promise<{ lines: string[]; exitCode: number }> {
  const cfg = o.configFile ?? syncConfigPath();
  const rulesFile = o.rulesFile ?? defaultRulesPath();
  const auditFile = o.auditFile ?? auditPath();
  const keyFile = path.join(path.dirname(cfg), SIGNING_KEY_FILE);
  const trustFile = path.join(path.dirname(cfg), TRUST_FILE);
  if (sub === "keygen") {
    if (!(await confirmed(o, `Create a signing key pair at ${keyFile}?`))) return { lines: ["No changes made."], exitCode: 1 };
    const r = generateKeypair(keyFile);
    return { lines: r.lines, exitCode: r.ok ? 0 : 1 };
  }
  if (sub === "trust") {
    if (!arg) return { lines: ["Usage: cephalo sync trust <public-key-file>"], exitCode: 1 };
    let pem: string;
    try {
      pem = fs.readFileSync(path.resolve(arg), "utf8");
    } catch {
      return { lines: [`Cannot read ${arg}.`], exitCode: 1 };
    }
    let id: string;
    try {
      id = keyId(pem);
    } catch {
      return { lines: ["That is not a public key in PEM form (it should start with -----BEGIN PUBLIC KEY-----)."], exitCode: 1 };
    }
    if (!(await confirmed(o, `Trust signing key ${id}? Verify this id with the admin first. Policy not signed by it will be refused.`))) return { lines: ["No changes made."], exitCode: 1 };
    const r = addTrusted(trustFile, pem);
    return { lines: r.lines, exitCode: r.ok ? 0 : 1 };
  }
  if (sub === "set") {
    if (!arg) return { lines: ["Usage: cephalo sync set <folder>"], exitCode: 1 };
    const dir = path.resolve(arg);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { lines: [`${dir} is not an existing folder. Create it (or clone the repo) first.`], exitCode: 1 };
    if (!(await confirmed(o, `Write ${cfg} pointing at ${dir}?`))) return { lines: ["No changes made."], exitCode: 1 };
    saveSyncDir(dir, cfg);
    return { lines: [`Shared folder set to ${dir}`], exitCode: 0 };
  }
  const dir = loadSyncDir(cfg);
  if (sub === "status") {
    if (!dir) return { lines: ["No shared folder set. Run: cephalo sync set <folder>"], exitCode: 0 };
    const m = readManifest(dir);
    const lines = [`Shared folder: ${dir}${fs.existsSync(dir) ? "" : "  (missing!)"}`, m ? `Shared policy: ${m.rules} rules, published ${m.at}${m.by ? ` by ${m.by}` : ""}` : "Shared policy: none published yet"];
    if (m) {
      const plan = planPull(dir, rulesFile, { trustFile });
      lines.push(plan.ok ? (plan.unchanged ? "Your rules match the shared policy." : "Your rules differ from the shared policy. See: cephalo sync pull") : `Shared policy problem: ${plan.lines[0]}`);
    }
    const nTrusted = loadTrusted(trustFile).length;
    lines.push(nTrusted ? `Signature check: on (${nTrusted} trusted key${nTrusted === 1 ? "" : "s"}); unsigned policy is refused.` : "Signature check: off (no trusted keys; run: cephalo sync trust <public-key-file>).");
    if (m) lines.push(m.signature ? `Shared policy is signed (key ${m.keyId ?? "?"}).` : "Shared policy is not signed.");
    const audits = fs.existsSync(path.join(dir, "audit")) ? fs.readdirSync(path.join(dir, "audit")).filter((f) => f.endsWith(".jsonl")) : [];
    lines.push(`Audit logs published: ${audits.length}${audits.length ? ` (${audits.join(", ")})` : ""}`);
    return { lines, exitCode: 0 };
  }
  if (sub !== "push" && sub !== "pull" && sub !== "audit") return { lines: [SYNC_USAGE], exitCode: 1 };
  if (!dir) return { lines: ["No shared folder set. Run: cephalo sync set <folder>"], exitCode: 1 };
  if (!fs.existsSync(dir)) return { lines: [`The shared folder ${dir} does not exist (drive not mounted?).`], exitCode: 1 };
  if (sub === "push") {
    if (!(await confirmed(o, `Publish ${rulesFile} to ${path.join(dir, "policy")}, replacing what is there?`))) return { lines: ["No changes made."], exitCode: 1 };
    const r = pushPolicy(dir, rulesFile, new Date(), { keyFile });
    return { lines: r.lines, exitCode: r.ok ? 0 : 1 };
  }
  if (sub === "pull") {
    const plan = planPull(dir, rulesFile, { trustFile });
    if (!plan.ok || plan.unchanged) return { lines: plan.lines, exitCode: plan.ok ? 0 : 1 };
    for (const l of plan.lines) console.log(l);
    if (!(await confirmed(o, `Replace ${rulesFile} with the shared policy (a backup is made first)?`))) return { lines: ["No changes made."], exitCode: 1 };
    return { lines: applyPull(plan, rulesFile), exitCode: 0 };
  }
  if (!(await confirmed(o, `Copy your audit log (commands, paths, decisions; tokens redacted) to ${path.join(dir, "audit")}, where everyone with access to that folder can read it?`))) return { lines: ["No changes made."], exitCode: 1 };
  const r = publishAudit(dir, auditFile);
  return { lines: r.lines, exitCode: r.ok ? 0 : 1 };
}

export const DASH_USAGE = `Usage: cephalo dashboard [--out <file>] [--team] [--days N] [--no-cost] [--force]

Writes one self-contained HTML page (no network access, nothing hosted): Overview, Sessions and cost, Seatbelt.
By default it shows this machine's audit log. --team reads every developer's log from the shared folder (cephalo sync audit).
Default output: ./cephalo-dashboard.html.`;

export interface DashOptions {
  out?: string;
  team?: boolean;
  days?: number;
  noCost?: boolean;
  force?: boolean;
  cwd: string;
  configFile?: string;
  auditFile?: string;
  now?: Date;
  cost?: Parameters<typeof costReport>[1];
}

export async function runDashboard(o: DashOptions): Promise<{ lines: string[]; exitCode: number }> {
  const days = o.days ?? 14;
  let entries;
  let source: string;
  if (o.team) {
    const dir = loadSyncDir(o.configFile ?? syncConfigPath());
    if (!dir) return { lines: ["No shared folder set. Run: cephalo sync set <folder>"], exitCode: 1 };
    entries = readTeamAudit(dir);
    source = path.join(dir, "audit");
    if (entries.length === 0) return { lines: [`No published audit logs in ${source}. Each developer runs: cephalo sync audit`], exitCode: 1 };
  } else {
    source = o.auditFile ?? auditPath();
    entries = readAudit({ limit: 0 }, source);
  }
  let cost;
  if (!o.team && !o.noCost) {
    try {
      cost = (await costReport({ since: `${days}d`, json: false, allProjects: true, noGithub: false, rows: 0 }, o.cost ?? { cwd: o.cwd, now: o.now })).report;
    } catch {
      /* the cost tab is optional */
    }
  }
  const data = buildDashboard(entries, { source, scope: o.team ? "team folder" : "this machine", days, now: o.now, cost });
  const out = path.resolve(o.cwd, o.out ?? "cephalo-dashboard.html");
  if (fs.existsSync(out) && !o.force && !fs.readFileSync(out, "utf8").includes("<title>Cephalo dashboard</title>")) {
    return { lines: [`${out} exists and is not a Cephalo dashboard. Pick another --out, or add --force.`], exitCode: 1 };
  }
  fs.writeFileSync(out, renderDashboard(data), "utf8");
  return { lines: [`Wrote ${out}`, `${data.totals.calls} calls, ${data.totals.blocked} blocked, ${data.totals.asked} asked in the last ${days} days (${data.scope}).`, "Open it in a browser. It makes no network requests."], exitCode: 0 };
}
