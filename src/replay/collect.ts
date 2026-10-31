import path from "node:path";
import { spawnSync } from "node:child_process";
import type { AuditEntry } from "../audit.js";
import { getVersion } from "../version.js";
import { statsOf, toEvents, type Replay } from "./model.js";

/* ------------------------------------------------------------------ time */

/** `30m`, `2h`, `1d`, `today`, or an ISO date/time. */
export function parseTimeSpec(spec: string, now: Date = new Date()): Date {
  const s = spec.trim();
  const rel = /^(\d+)\s*(m|min|h|d)$/i.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    return new Date(now.getTime() - n * (unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000));
  }
  if (/^today$/i.test(s)) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`Cannot read "${spec}" as a time. Use 30m, 2h, 1d, today, or a date such as 2026-10-30T14:00:00Z.`);
  return new Date(t);
}

/* ------------------------------------------------------------------ git */

export type GitRun = (args: string[], cwd: string) => { status: number | null; stdout: string };

export const defaultGit: GitRun = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 10_000 });
  return { status: r.status, stdout: r.stdout ?? "" };
};

export interface GitInfo {
  root?: string;
  branch?: string;
  head?: string;
  base?: string;
  /** The author-date of the oldest commit that is on this branch but not on the base. */
  firstCommitAt?: string;
  commits?: number;
  remote?: string;
}

/** Strip credentials out of a remote URL before it goes anywhere near a PR. */
export function cleanRemote(url: string): string {
  return url.trim().replace(/^(https?:\/\/)[^/@\s]+@/i, "$1");
}

export function gitInfo(cwd: string, run: GitRun = defaultGit): GitInfo {
  const out = (args: string[]) => {
    const r = run(args, cwd);
    return r.status === 0 ? r.stdout.trim() : undefined;
  };
  const root = out(["rev-parse", "--show-toplevel"]);
  if (!root) return {};
  const info: GitInfo = { root: root.replace(/\\/g, "/") };
  const branch = out(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch && branch !== "HEAD") info.branch = branch;
  info.head = out(["rev-parse", "--short", "HEAD"]);
  const remote = out(["config", "--get", "remote.origin.url"]);
  if (remote) info.remote = cleanRemote(remote);

  const candidates: string[] = [];
  const originHead = out(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead) candidates.push(originHead);
  candidates.push("origin/main", "origin/master", "main", "master");
  const base = candidates.find((c) => c !== info.branch && out(["rev-parse", "--verify", "--quiet", c]) !== undefined);
  if (base) {
    info.base = base;
    const mb = out(["merge-base", "HEAD", base]);
    if (mb) {
      const log = out(["log", `${mb}..HEAD`, "--format=%aI", "--max-count=5000"]);
      const dates = log ? log.split(/\r?\n/).filter(Boolean) : [];
      info.commits = dates.length;
      if (dates.length) info.firstCommitAt = dates[dates.length - 1];
    }
  }
  return info;
}

/** https://github.com/o/r.git or git@github.com:o/r.git -> https://github.com/o/r */
export function webUrlOf(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  const m = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(remote);
  return m ? `https://github.com/${m[1]}` : undefined;
}

/* ------------------------------------------------------------------ selection */

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
export const within = (root: string, p: string) => {
  const r = norm(root);
  const x = norm(p);
  return x === r || x.startsWith(`${r}/`);
};

export interface SelectOptions {
  since?: Date;
  until?: Date;
  /** Session id (a prefix is enough). */
  session?: string;
  /** Keep only entries from this project directory. */
  root?: string;
  /** Do not filter by project. */
  allProjects?: boolean;
  /** Drop entries that have no project recorded (logged before replays existed) instead of including them by time. */
  strict?: boolean;
}

export function selectEntries(entries: AuditEntry[], o: SelectOptions): { entries: AuditEntry[]; notes: string[] } {
  const notes: string[] = [];
  let list = entries.filter((e) => {
    const t = Date.parse(e.ts);
    if (Number.isNaN(t)) return false;
    if (o.since && t < o.since.getTime()) return false;
    if (o.until && t > o.until.getTime()) return false;
    return true;
  });
  if (o.session) list = list.filter((e) => e.session?.startsWith(o.session!));
  if (o.root && !o.allProjects) {
    let other = 0;
    let unknown = 0;
    list = list.filter((e) => {
      if (!e.cwd) {
        if (o.strict) return false;
        unknown++;
        return true;
      }
      if (within(o.root!, e.cwd)) return true;
      other++;
      return false;
    });
    if (other) notes.push(other === 1 ? "1 entry from another project was left out." : `${other} entries from other projects were left out.`);
    if (unknown) notes.push(`${unknown} entr${unknown === 1 ? "y has" : "ies have"} no project recorded (logged before replays existed), so ${unknown === 1 ? "it is" : "they are"} included by time only.`);
    if (o.strict) notes.push("Entries with no recorded project were excluded (--strict).");
  }
  list.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return { entries: list, notes };
}

/* ------------------------------------------------------------------ build */

export interface BuildOptions extends SelectOptions {
  cwd: string;
  git?: GitRun;
  now?: Date;
  pr?: number;
  /** Where the entries came from (shown in the footer). */
  source?: string;
  /** Hours before the first branch commit to start from when --since is not given. */
  leadHours?: number;
}

export function buildReplay(all: AuditEntry[], o: BuildOptions): Replay {
  const now = o.now ?? new Date();
  const git = gitInfo(o.cwd, o.git);
  const notes: string[] = [];
  let since = o.since;
  let basis = "explicit --since";
  if (!since) {
    if (git.firstCommitAt) {
      const lead = o.leadHours ?? 2;
      since = new Date(Date.parse(git.firstCommitAt) - lead * 3_600_000);
      basis = `branch ${git.branch ?? "(detached)"} commits since ${git.base}: first commit ${git.firstCommitAt}, starting ${lead}h earlier because work usually comes before the first commit`;
    } else {
      since = new Date(now.getTime() - 86_400_000);
      basis = git.root ? `last 24 hours (no commits ahead of ${git.base ?? "a base branch"} to anchor on)` : "last 24 hours (not inside a git repository)";
    }
  }
  const sel = selectEntries(all, { ...o, since, root: o.root ?? git.root });
  notes.push(...sel.notes);
  const events = toEvents(sel.entries);
  const web = webUrlOf(git.remote);
  return {
    meta: {
      generatedAt: now.toISOString(),
      version: getVersion(),
      repo: git.root ? { root: path.basename(git.root), branch: git.branch, base: git.base, head: git.head, remote: web ?? git.remote } : undefined,
      ...(o.pr ? { pr: { number: o.pr, ...(web ? { url: `${web}/pull/${o.pr}` } : {}) } } : {}),
      window: { since: since.toISOString(), until: o.until?.toISOString(), basis },
      notes,
    },
    stats: statsOf(events),
    events,
  };
}
