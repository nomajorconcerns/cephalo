import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readAudit } from "./audit.js";
import { buildReplay, parseTimeSpec, webUrlOf, type GitRun } from "./replay/collect.js";
import type { Bundle } from "./replay/bundle.js";
import { renderHtml } from "./replay/html.js";
import { DEFAULT_MAX_CHARS, MARKER, renderMarkdown } from "./replay/markdown.js";
import { formatDuration, needsAttention, type Replay } from "./replay/model.js";
import { sanitize } from "./watch.js";

export type ReplayFormat = "text" | "md" | "html" | "json" | "bundle";

export interface ReplayArgs {
  since?: string;
  until?: string;
  session?: string;
  format: ReplayFormat;
  out?: string;
  allProjects: boolean;
  strict: boolean;
  pr?: number;
  repo?: string;
  maxChars?: number;
  comment: boolean;
  update: boolean;
  yes: boolean;
  force: boolean;
}

const VALUE_FLAGS = ["--since", "--until", "--session", "--format", "--out", "--pr", "--repo", "--max-chars"];

export function parseReplayArgs(argv: string[]): { args: ReplayArgs } | { error: string } {
  const val = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  for (const f of VALUE_FLAGS) if (argv.includes(f) && (val(f) === undefined || val(f)!.startsWith("--"))) return { error: `${f} needs a value.` };
  const known = new Set([...VALUE_FLAGS, "--all-projects", "--strict", "--comment", "--update", "--yes", "-y", "--force", "--no-github"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.includes(a)) {
      i++;
      continue;
    }
    if (!known.has(a)) return { error: `Unknown option ${a}. See: cephalo replay --help` };
  }
  const format = (val("--format") ?? (argv.includes("--comment") ? "md" : "text")) as ReplayFormat;
  if (!["text", "md", "html", "json", "bundle"].includes(format)) return { error: `--format must be text, md, html, json or bundle (got ${format}).` };
  const pr = val("--pr");
  if (pr !== undefined && !/^\d+$/.test(pr)) return { error: "--pr needs a pull request number." };
  const max = val("--max-chars");
  if (max !== undefined && !/^\d{3,6}$/.test(max)) return { error: "--max-chars needs a number between 100 and 999999." };
  if (argv.includes("--update") && !argv.includes("--comment")) return { error: "--update only makes sense together with --comment." };
  return {
    args: {
      since: val("--since"),
      until: val("--until"),
      session: val("--session"),
      format,
      out: val("--out"),
      allProjects: argv.includes("--all-projects"),
      strict: argv.includes("--strict"),
      pr: pr ? Number(pr) : undefined,
      repo: val("--repo"),
      maxChars: max ? Number(max) : undefined,
      comment: argv.includes("--comment"),
      update: argv.includes("--update"),
      yes: argv.includes("--yes") || argv.includes("-y"),
      force: argv.includes("--force"),
    },
  };
}

export interface ReplayEnv {
  cwd: string;
  auditFile?: string;
  git?: GitRun;
  now?: Date;
}

export function collectReplay(a: ReplayArgs, env: ReplayEnv): Replay {
  const now = env.now ?? new Date();
  return buildReplay(readAudit({ limit: 0 }, env.auditFile), {
    cwd: env.cwd,
    git: env.git,
    now,
    since: a.since ? parseTimeSpec(a.since, now) : undefined,
    until: a.until ? parseTimeSpec(a.until, now) : undefined,
    session: a.session,
    allProjects: a.allProjects,
    strict: a.strict,
    pr: a.pr,
  });
}

/** Human-readable summary for the terminal. */
export function terminalSummary(r: Replay): string[] {
  const s = r.stats;
  const m = r.meta;
  const lines: string[] = [];
  const where = [m.repo?.branch && `branch ${m.repo.branch}`, m.repo?.base && `base ${m.repo.base}`].filter(Boolean).join(", ");
  if (!s.total) {
    lines.push("No agent activity was recorded in this window.", `Window: ${m.window.basis}`);
    for (const n of m.notes) lines.push(`  ${n}`);
    return lines;
  }
  lines.push(`Replay: ${s.calls} tool calls, ${s.first} to ${s.last} (${formatDuration(s.durationMs)})${where ? `   ${where}` : ""}`);
  lines.push(`  agents: ${s.agents.join(", ")}${s.users.length ? ` (${s.users.join(", ")})` : ""}   sessions: ${s.sessions || "unknown"}`);
  lines.push(`  blocked: ${s.blocked}${Object.keys(s.byRule).length ? ` (${Object.entries(s.byRule).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} x${v}`).join(", ")})` : ""}`);
  lines.push(`  injection signals: ${s.tripwire.alert} alert, ${s.tripwire.watch} watch   credential leaks: ${s.leaks}   vault runs: ${s.vault.runs}${s.vault.names.length ? ` (${s.vault.names.join(", ")})` : ""}   MCP calls: ${s.mcp.calls}`);
  lines.push(`  files written: ${s.filesWritten.length}`);
  const att = r.events.filter(needsAttention);
  if (att.length) {
    lines.push("", "Needs attention:");
    for (const e of att.slice(0, 12)) lines.push(`  ${e.ts.slice(5, 19).replace("T", " ")}  ${e.kind === "block" ? "BLOCKED" : e.kind.toUpperCase()}  ${e.agent}/${e.tool}  ${sanitize(e.subject || e.note || "").slice(0, 100)}${e.rule ? `  [${e.rule}]` : ""}`);
    if (att.length > 12) lines.push(`  ...and ${att.length - 12} more`);
  }
  lines.push("", `Window: ${m.window.basis}`);
  for (const n of m.notes) lines.push(`  ${n}`);
  lines.push("", "Export:  cephalo replay --format html --out replay.html     (interactive)", "         cephalo replay --format md                         (PR comment text)", "         cephalo replay --pr <number> --comment             (post it to the PR)");
  return lines;
}

export function render(r: Replay, a: ReplayArgs, bundle?: Bundle): string {
  switch (a.format) {
    case "md":
      return renderMarkdown(r, { maxChars: a.maxChars ?? DEFAULT_MAX_CHARS });
    case "html":
      return renderHtml(r);
    case "bundle":
      return renderHtml(r, bundle);
    case "json":
      return JSON.stringify(r, null, 2);
    default:
      return terminalSummary(r).join("\n");
  }
}

/** Write a generated file. An existing file is copied aside first, never silently replaced. */
export function writeOutput(content: string, file: string, force = false): string[] {
  const out: string[] = [];
  const abs = path.resolve(file);
  if (fs.existsSync(abs)) {
    if (!force) throw new Error(`${abs} already exists. Use --force to replace it (the old file is kept as a .cephalo-backup copy).`);
    const bk = `${abs}.cephalo-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(abs, bk);
    out.push(`Backup of the old file: ${bk}`);
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  out.push(`Wrote ${abs} (${content.length} characters)`);
  return out;
}

/* ------------------------------------------------------------------ posting to a PR */

export type GhResult = { status: number | null; stdout: string; stderr: string };
export type GhRun = (args: string[], input?: string, cwd?: string) => GhResult;

export const defaultGh: GhRun = (args, input, cwd) => {
  const r = spawnSync("gh", args, { input, cwd, encoding: "utf8", windowsHide: true, timeout: 60_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

export interface CommentPlan {
  ok: boolean;
  lines: string[];
  body?: string;
  pr?: number;
}

/** Work out what would be posted and where, without posting anything. */
export function planComment(r: Replay, a: ReplayArgs, env: ReplayEnv, gh: GhRun = defaultGh): CommentPlan {
  const repoArgs = a.repo ? ["-R", a.repo] : [];
  let pr = a.pr;
  const lines: string[] = [];
  if (pr === undefined) {
    const v = gh(["pr", "view", ...repoArgs, "--json", "number", "-q", ".number"], undefined, env.cwd);
    if (v.status !== 0 || !/^\d+$/.test(v.stdout.trim())) return { ok: false, lines: ["Could not tell which pull request to use. Pass --pr <number>, or run this from the PR's branch with the GitHub CLI (gh) signed in."] };
    pr = Number(v.stdout.trim());
    lines.push(`Detected PR #${pr} for the current branch.`);
  }
  // the PR we are about to post to always wins over whatever the replay was built with
  const web = webUrlOf(r.meta.repo?.remote);
  const body = renderMarkdown({ ...r, meta: { ...r.meta, pr: { number: pr, ...(web ? { url: `${web}/pull/${pr}` } : {}) } } }, { maxChars: a.maxChars ?? DEFAULT_MAX_CHARS });
  lines.push(`Post the replay (${body.length} characters, ${r.stats.total} events) as ${a.update ? "an updated or new" : "a new"} comment on PR #${pr}${a.repo ? ` in ${a.repo}` : ""}.`, "It is posted with your own GitHub login (gh), and is visible to everyone who can see the PR.", "Secrets are redacted and your home folder is shown as ~, but commands and file paths are included. Read it first:  cephalo replay --format md");
  return { ok: true, lines, body, pr };
}

/** Post (or update) the comment. `--update` only ever edits a comment that carries Cephalo's hidden marker. */
export function postComment(plan: CommentPlan, a: ReplayArgs, env: ReplayEnv, gh: GhRun = defaultGh): { ok: boolean; lines: string[] } {
  if (!plan.ok || !plan.body || plan.pr === undefined) return { ok: false, lines: plan.lines };
  const repoArgs = a.repo ? ["-R", a.repo] : [];
  if (a.update) {
    const who = gh(["api", "user", "-q", ".login"], undefined, env.cwd);
    const login = who.stdout.trim();
    if (who.status === 0 && /^[A-Za-z0-9-]+$/.test(login)) {
      const slug = a.repo ?? "{owner}/{repo}";
      const found = gh(["api", `repos/${slug}/issues/${plan.pr}/comments`, "--paginate", "-q", `.[] | select(.user.login=="${login}") | select(.body | contains("${MARKER}")) | .id`], undefined, env.cwd);
      const ids = found.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
      if (found.status === 0 && ids.length) {
        const id = ids[ids.length - 1];
        const r = gh(["api", "-X", "PATCH", `repos/${slug}/issues/comments/${id}`, "-F", "body=@-"], plan.body, env.cwd);
        return r.status === 0 ? { ok: true, lines: [`Updated your earlier Cephalo replay comment on PR #${plan.pr}.`] } : { ok: false, lines: [`GitHub refused the update: ${r.stderr.trim().slice(0, 300) || "unknown error"}`] };
      }
    }
  }
  const r = gh(["pr", "comment", String(plan.pr), ...repoArgs, "--body-file", "-"], plan.body, env.cwd);
  if (r.status !== 0) return { ok: false, lines: [`gh could not post the comment: ${r.stderr.trim().slice(0, 300) || "unknown error"}`, "Nothing was posted."] };
  return { ok: true, lines: [`Posted the replay to PR #${plan.pr}.${r.stdout.trim() ? ` ${r.stdout.trim()}` : ""}`] };
}
