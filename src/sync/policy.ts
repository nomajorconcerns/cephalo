import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";
import { cephaloDir, parseRules, type Rule } from "../rules.js";
import { currentUser } from "../user.js";
import { redactTokens } from "../vault/patterns.js";
import type { AuditEntry } from "../audit.js";

export function syncConfigPath(): string {
  return path.join(cephaloDir(), "sync.yml");
}

/** The shared folder (a synced drive, or a clone of a git repo). null = not set up. */
export function loadSyncDir(file = syncConfigPath()): string | null {
  try {
    const d = parse(fs.readFileSync(file, "utf8"));
    return typeof d?.dir === "string" && d.dir.trim() ? d.dir.trim() : null;
  } catch {
    return null;
  }
}

export function saveSyncDir(dir: string, file = syncConfigPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# Shared folder for team policy and audit sync (cephalo sync).\n${stringify({ dir })}`, "utf8");
}

const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
const policyDir = (dir: string) => path.join(dir, "policy");

export interface Manifest {
  sha256: string;
  by?: string;
  at: string;
  rules: number;
}

export function readManifest(dir: string): Manifest | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(policyDir(dir), "MANIFEST.json"), "utf8"));
    return typeof m?.sha256 === "string" && typeof m?.at === "string" ? m : null;
  } catch {
    return null;
  }
}

export interface RuleDiff {
  added: Rule[];
  removed: Rule[];
  changed: Array<{ before: Rule; after: Rule }>;
}

const same = (a: Rule, b: Rule) => a.description === b.description && a.type === b.type && a.on === b.on && a.pattern === b.pattern && a.action === b.action;

export function diffRules(local: Rule[], shared: Rule[]): RuleDiff {
  const l = new Map(local.map((r) => [r.id, r]));
  const s = new Map(shared.map((r) => [r.id, r]));
  return {
    added: shared.filter((r) => !l.has(r.id)),
    removed: local.filter((r) => !s.has(r.id)),
    changed: shared.filter((r) => l.has(r.id) && !same(l.get(r.id)!, r)).map((r) => ({ before: l.get(r.id)!, after: r })),
  };
}

export interface PushResult {
  ok: boolean;
  lines: string[];
}

/** Publish the local rules file to the shared folder, with a manifest holding its SHA-256. Refuses an invalid rules file. */
export function pushPolicy(dir: string, rulesFile: string, now = new Date()): PushResult {
  if (!fs.existsSync(rulesFile)) return { ok: false, lines: [`${rulesFile} does not exist, nothing to publish.`] };
  const text = fs.readFileSync(rulesFile, "utf8");
  const parsed = parseRules(text);
  if (parsed.problems.length) return { ok: false, lines: [`Not publishing: ${rulesFile} has problems: ${parsed.problems.join("; ")}`] };
  const target = policyDir(dir);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "rules.yml"), text, "utf8");
  const manifest: Manifest = { sha256: sha(text), by: currentUser(), at: now.toISOString(), rules: parsed.rules.length };
  fs.writeFileSync(path.join(target, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return { ok: true, lines: [`Published ${parsed.rules.length} rules to ${path.join(target, "rules.yml")}`, `SHA-256 ${manifest.sha256.slice(0, 16)}…`, "If this folder is a git repo, review and commit it yourself (Cephalo does not run git here)."] };
}

export interface PullPlan {
  ok: boolean;
  lines: string[];
  /** Nothing to do (already identical). */
  unchanged?: boolean;
  diff?: RuleDiff;
  text?: string;
}

/** What pulling the shared policy would change. Checks the manifest hash and that the rules parse; never writes. */
export function planPull(dir: string, rulesFile: string): PullPlan {
  const shared = path.join(policyDir(dir), "rules.yml");
  if (!fs.existsSync(shared)) return { ok: false, lines: [`No shared policy at ${shared}. Someone has to run: cephalo sync push`] };
  const text = fs.readFileSync(shared, "utf8");
  const m = readManifest(dir);
  if (!m) return { ok: false, lines: [`${shared} has no MANIFEST.json next to it, so it cannot be checked. Refusing.`] };
  if (m.sha256 !== sha(text)) return { ok: false, lines: [`${shared} does not match its manifest (hash differs). It was edited or only partly synced. Refusing.`] };
  const parsed = parseRules(text);
  if (parsed.problems.length) return { ok: false, lines: [`The shared rules file has problems: ${parsed.problems.join("; ")}. Refusing.`] };
  const local = fs.existsSync(rulesFile) ? parseRules(fs.readFileSync(rulesFile, "utf8")).rules : [];
  const diff = diffRules(local, parsed.rules);
  const lines = [`Shared policy: ${parsed.rules.length} rules, published ${m.at}${m.by ? ` by ${m.by}` : ""}.`, "(The hash only shows the file arrived intact. It does not prove who wrote it; anyone with write access to the folder can publish.)"];
  if (!diff.added.length && !diff.removed.length && !diff.changed.length) return { ok: true, unchanged: true, lines: [...lines, "Your rules already match. Nothing to do."], diff, text };
  for (const r of diff.removed) lines.push(`  REMOVES  ${r.id}: ${r.description}   (this makes your rules weaker)`);
  for (const c of diff.changed) lines.push(`  CHANGES  ${c.after.id}: ${c.before.pattern === c.after.pattern ? "description or scope" : "pattern"} differs`);
  for (const r of diff.added) lines.push(`  ADDS     ${r.id}: ${r.description}`);
  return { ok: true, lines, diff, text };
}

/** Write the pulled rules, after backing up the local file. */
export function applyPull(plan: PullPlan, rulesFile: string): string[] {
  if (!plan.ok || plan.text === undefined) return ["Nothing applied."];
  const out: string[] = [];
  if (fs.existsSync(rulesFile)) {
    const backup = `${rulesFile}.cephalo-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(rulesFile, backup);
    out.push(`Backup: ${backup}`);
  }
  fs.mkdirSync(path.dirname(rulesFile), { recursive: true });
  fs.writeFileSync(rulesFile, plan.text, "utf8");
  out.push(`Updated ${rulesFile}`);
  return out;
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60) || "unknown";

export function auditTargetName(user = currentUser(), host = os.hostname()): string {
  return `${safeName(user ?? "unknown")}@${safeName(host)}.jsonl`;
}

/** Copy this machine's audit log into the shared folder (one file per user and machine). Tokens are redacted again on the way out. */
export function publishAudit(dir: string, auditFile: string, name = auditTargetName()): { ok: boolean; lines: string[]; entries: number } {
  if (!fs.existsSync(auditFile)) return { ok: false, lines: [`${auditFile} does not exist, nothing to publish.`], entries: 0 };
  const lines = fs.readFileSync(auditFile, "utf8").split(/\r?\n/).filter((l) => l.trim());
  const target = path.join(dir, "audit");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, name), redactTokens(lines.join("\n")) + "\n", "utf8");
  return { ok: true, entries: lines.length, lines: [`Published ${lines.length} audit entries to ${path.join(target, name)}`] };
}

/** Every developer's published audit log, newest last. A file's name tells whose it is when an entry has no user. */
export function readTeamAudit(dir: string): AuditEntry[] {
  const target = path.join(dir, "audit");
  let files: string[] = [];
  try {
    files = fs.readdirSync(target).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out: AuditEntry[] = [];
  for (const f of files) {
    const who = f.replace(/\.jsonl$/, "");
    for (const line of fs.readFileSync(path.join(target, f), "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as AuditEntry;
        if (e && typeof e.ts === "string") out.push({ ...e, user: e.user ?? who });
      } catch {
        /* skip a damaged line */
      }
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}
