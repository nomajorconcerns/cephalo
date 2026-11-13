import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { getVersion } from "./version.js";

export const PACKAGE_NAME = "@nomajorconcerns/cephalo";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME.replace("/", "%2f")}/latest`;

export const UPDATE_USAGE = `Usage: cephalo update [--check] [--yes]

Updates Cephalo to the newest version on npm. The same as:
  npm install -g ${PACKAGE_NAME}@latest

  --check   only look: say whether a newer version exists, change nothing
  --yes     do not ask before installing

This command only talks to the public npm registry, and only when you run it. Cephalo never checks for updates by itself.
An update leaves your rules (~/.cephalo/rules.yml), audit log, settings and license alone. After it, run: cephalo doctor
(New default rules are not added to an existing rules file; "cephalo rules" lists what is missing.)
The paid Pro package is a separate download from your order and is not updated by this command.
`;

export interface NpmOut {
  status: number;
  stdout: string;
  stderr: string;
}
export interface UpdateDeps {
  current?: string;
  /** Fetches the registry's JSON for the latest version. Replaced in tests: no test touches the network. */
  fetchLatest?: () => Promise<string>;
  /** Runs npm. Replaced in tests: nothing in the test suite installs a package. */
  runNpm?: (args: string[]) => NpmOut;
  /** The real path of this running copy of Cephalo's cli. */
  selfPath?: string;
  /** Asks a yes/no question; null when there is no terminal. */
  confirm?: (question: string) => Promise<boolean> | null;
}
export interface UpdateResult {
  lines: string[];
  exitCode: number;
}

/** [major, minor, patch] of a plain x.y.z version; null for anything else (pre-releases are never offered). */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Positive when a is newer than b. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

async function defaultFetchLatest(): Promise<string> {
  const res = await fetch(REGISTRY_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`the npm registry answered ${res.status}`);
  const body = (await res.json()) as { version?: unknown };
  if (typeof body.version !== "string" || !parseVersion(body.version)) throw new Error("the npm registry sent no usable version");
  return body.version;
}

function defaultRunNpm(args: string[]): NpmOut {
  const r = spawnSync("npm", args.map((a) => `"${a.replace(/"/g, '\\"')}"`), { shell: true, encoding: "utf8", timeout: 300_000 });
  return { status: r.status ?? 1, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") + (r.error ? ` ${r.error.message}` : "") };
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** True when this running copy sits in npm's global folder, so `npm install -g` replaces it. A git checkout or an `npm link` does not. */
export function isGlobalNpmInstall(selfPath: string, globalRoot: string): boolean {
  const own = real(path.join(globalRoot, ...PACKAGE_NAME.split("/")));
  const self = real(selfPath);
  const rel = path.relative(own, self);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Pure parser so the command and its tests agree on the flags. */
export function parseUpdateArgs(args: string[]): { check: boolean; yes: boolean; unknown: string[] } {
  const known = new Set(["--check", "--yes", "-y"]);
  return { check: args.includes("--check"), yes: args.includes("--yes") || args.includes("-y"), unknown: args.filter((a) => !known.has(a)) };
}

export async function updateCommand(args: string[], d: UpdateDeps = {}): Promise<UpdateResult> {
  const opts = parseUpdateArgs(args);
  if (opts.unknown.length) return { lines: [`Unknown option: ${opts.unknown.join(" ")}`, UPDATE_USAGE.trimEnd()], exitCode: 1 };

  const current = d.current ?? getVersion();
  let latest: string;
  try {
    latest = await (d.fetchLatest ?? defaultFetchLatest)();
  } catch (e) {
    return { lines: [`Could not check for a newer version: ${(e as Error).message}.`, `You can still update by hand: npm install -g ${PACKAGE_NAME}@latest`], exitCode: 1 };
  }

  if (compareVersions(latest, current) <= 0) {
    return { lines: [`Cephalo ${current} is up to date (newest on npm: ${latest}).`], exitCode: 0 };
  }
  const found = `Update available: ${current} -> ${latest}`;
  const manual = `npm install -g ${PACKAGE_NAME}@${latest}`;
  if (opts.check) return { lines: [found, "Install it with: cephalo update"], exitCode: 0 };

  const run = d.runNpm ?? defaultRunNpm;
  const g = run(["root", "-g"]);
  const globalRoot = g.status === 0 ? g.stdout.trim().split(/\r?\n/).pop() ?? "" : "";
  const self = d.selfPath ?? fileURLToPath(import.meta.url);
  if (!globalRoot || !isGlobalNpmInstall(self, globalRoot)) {
    return {
      lines: [
        found,
        "This copy of Cephalo was not installed with `npm install -g` (it is a git checkout, an `npm link`, or a project-local install),",
        `so it will not be replaced automatically. Update it the way you installed it, or install the release with: ${manual}`,
      ],
      exitCode: 1,
    };
  }

  if (!opts.yes) {
    const ask = d.confirm?.(`${found}. Install it now? [y/N] `);
    if (!ask) return { lines: [found, `No terminal to ask in. Run: cephalo update --yes`, `or: ${manual}`], exitCode: 1 };
    if (!(await ask)) return { lines: [found, "Not installed."], exitCode: 0 };
  }

  const r = run(["install", "-g", `${PACKAGE_NAME}@${latest}`, "--no-audit", "--no-fund", "--loglevel=error"]);
  if (r.status !== 0) {
    const text = r.stderr.split(/\r?\n/).filter(Boolean).slice(-4).join(" | ").slice(0, 400);
    return { lines: [`The update failed${text ? ` (${text})` : ""}. Your current version was not changed by Cephalo.`, `Try by hand: ${manual}`], exitCode: 1 };
  }
  return {
    lines: [
      `Updated Cephalo ${current} -> ${latest}.`,
      "Your rules, audit log, settings and license were not touched. Next: cephalo doctor",
      "If the release notes mention new hook matchers, run once: cephalo install claude (and cephalo install hermes if you use Hermes).",
      "To see default rules your rules file does not have yet: cephalo rules",
    ],
    exitCode: 0,
  };
}
