import { spawnSync } from "node:child_process";
import type { SessionCost } from "./usage.js";

export type CiState = "pass" | "fail" | "pending" | "none";

export interface PrInfo {
  number: number;
  url?: string;
  state: "MERGED" | "OPEN" | "CLOSED";
  /** CI result on the PR's head commit. */
  ci: CiState;
}

/** How a session ended up. Only "shipped" counts as a result. */
export type ShipStatus = "shipped" | "merged-ci-failed" | "merged-no-ci" | "open" | "closed" | "no-pr" | "no-branch" | "unknown";

export interface Shipped {
  status: ShipStatus;
  pr?: PrInfo;
}

/** Looks up the pull requests for a branch. null = could not find out (no gh, no network, not a repo). */
export type PrLookup = (cwd: string, branch: string) => PrInfo[] | null;

const DEFAULT_BRANCHES = new Set(["main", "master", "HEAD", "develop", "trunk", ""]);

export function ciOf(rollup: unknown): CiState {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  let pending = false;
  for (const c of rollup as any[]) {
    const v = String(c?.conclusion ?? c?.state ?? c?.status ?? "").toUpperCase();
    if (["FAILURE", "TIMED_OUT", "CANCELLED", "ERROR", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(v)) return "fail";
    if (["", "PENDING", "IN_PROGRESS", "QUEUED", "WAITING", "REQUESTED", "EXPECTED"].includes(v)) pending = true;
  }
  return pending ? "pending" : "pass";
}

/** The real lookup: `gh pr list --head <branch> --state all`, run in the session's directory. */
export const ghLookup: PrLookup = (cwd, branch) => {
  const r = spawnSync("gh", ["pr", "list", "--head", branch, "--state", "all", "--limit", "5", "--json", "number,state,url,statusCheckRollup"], { cwd, encoding: "utf8", timeout: 20000 });
  if (r.status !== 0 || r.error) return null;
  try {
    const rows = JSON.parse(r.stdout) as any[];
    return rows.map((p) => ({ number: p.number, url: p.url, state: p.state, ci: ciOf(p.statusCheckRollup) }));
  } catch {
    return null;
  }
};

export function classify(prs: PrInfo[] | null): Shipped {
  if (prs === null) return { status: "unknown" };
  if (prs.length === 0) return { status: "no-pr" };
  const merged = prs.find((p) => p.state === "MERGED");
  if (merged) return { status: merged.ci === "pass" ? "shipped" : merged.ci === "none" ? "merged-no-ci" : "merged-ci-failed", pr: merged };
  const open = prs.find((p) => p.state === "OPEN");
  if (open) return { status: "open", pr: open };
  return { status: "closed", pr: prs[0] };
}

/** Work out, per session, whether it shipped. Each (directory, branch) is looked up once. */
export function shipStatuses(sessions: SessionCost[], lookup: PrLookup = ghLookup): Map<SessionCost, Shipped> {
  const cache = new Map<string, Shipped>();
  const out = new Map<SessionCost, Shipped>();
  for (const s of sessions) {
    if (!s.cwd || !s.branch || DEFAULT_BRANCHES.has(s.branch)) {
      out.set(s, { status: "no-branch" });
      continue;
    }
    const key = `${s.cwd}\0${s.branch}`;
    if (!cache.has(key)) cache.set(key, classify(lookup(s.cwd, s.branch)));
    out.set(s, cache.get(key)!);
  }
  return out;
}
