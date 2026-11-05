import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeSettingsPath, hermesConfigPath, projectRoot } from "./install.js";
import { cephaloDir } from "./rules.js";
import { claudeStatus, hermesStatus } from "./status.js";
import { sessionKey } from "./tripwire/state.js";

/**
 * Self-integrity check. Two questions:
 *   1. Is the hook entry still in the agent's config, and does it point at this install?
 *   2. Do the installed files (dist/) still match the SHA-256 list written when this version was built?
 * It runs on the first hook call of each session and in `cephalo doctor`. It detects; it cannot prevent. Someone who can
 * change dist/ as you can also change the list (dist/integrity.json), so it catches accidents and clumsy tampering,
 * not a determined attacker running as you.
 */
export const MANIFEST_NAME = "integrity.json";

/** The folder the running code was loaded from (the dist/ of this install). */
export function installDist(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

export interface FilesResult {
  /** Files compared against the list. */
  checked: number;
  hasManifest: boolean;
  problems: string[];
}

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function walk(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (r === "tests") continue; // compiled tests are not part of the install
      out.push(...walk(path.join(dir, e.name), r));
    } else if (e.isFile() && r !== MANIFEST_NAME) out.push(r);
  }
  return out;
}

/** Compare the installed files with the list written at build time. Never throws. */
export function verifyFiles(dist: string = installDist()): FilesResult {
  const manifestFile = path.join(dist, MANIFEST_NAME);
  let listed: Record<string, string>;
  try {
    const m = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    if (!m || typeof m.files !== "object" || m.files === null) throw new Error("no files list");
    listed = m.files as Record<string, string>;
  } catch (e) {
    const missing = !fs.existsSync(manifestFile);
    return {
      checked: 0,
      hasManifest: false,
      problems: [missing ? `${MANIFEST_NAME} is missing from ${dist}, so the installed files cannot be checked (run: npm run build)` : `${MANIFEST_NAME} in ${dist} cannot be read: ${(e as Error).message}`],
    };
  }
  const problems: string[] = [];
  let checked = 0;
  for (const [rel, want] of Object.entries(listed)) {
    const f = path.join(dist, rel);
    try {
      const got = sha256(f);
      checked++;
      if (got !== want) problems.push(`${rel} has changed since it was built`);
    } catch {
      problems.push(`${rel} is missing`);
    }
  }
  try {
    for (const rel of walk(dist)) if (!(rel in listed)) problems.push(`${rel} is not part of this install (unexpected file)`);
  } catch {
    problems.push(`cannot list ${dist}`);
  }
  return { checked, hasManifest: true, problems };
}

/** Pull the cli.js path out of "node <path> hook <agent>". */
function commandTarget(command: string | undefined): string | undefined {
  return command?.match(/^node\s+"?(.+?cli\.js)"?\s+hook\s/)?.[1];
}

const same = (a: string, b: string) => {
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a).toLowerCase() === real(b).toLowerCase();
};

export interface HookEntryOptions {
  claudeFile?: string;
  hermesFile?: string;
  /** The project root the hook entry should point at (default: where this install lives). */
  abs?: string;
}

/** Problems with the agent's hook entry. Only Claude Code and Hermes have a config Cephalo reads; for other agents this says nothing. */
export function hookEntryProblems(agent: string, o: HookEntryOptions = {}): string[] {
  const abs = o.abs ?? projectRoot();
  const family = agent === "claude" || agent === "hermes" ? agent : undefined;
  if (!family) return [];
  const file = family === "claude" ? (o.claudeFile ?? claudeSettingsPath()) : (o.hermesFile ?? hermesConfigPath());
  const st = family === "claude" ? claudeStatus(file, abs) : hermesStatus(file, abs);
  const name = family === "claude" ? "Claude Code" : "Hermes";
  if (st.error) return [`cannot read the ${name} config ${file}: ${st.error}`];
  if (!st.fileExists) return [`the ${name} config ${file} no longer exists, so this hook is not installed`];
  if (!st.installed) return [`the Cephalo hook entry is gone from ${file}: tool calls may not be checked`];
  const out: string[] = [];
  const target = commandTarget(st.command);
  if (target && !same(target, path.join(abs, "dist", "cli.js"))) out.push(`the hook entry in ${file} points at ${target}, not at this install (${path.join(abs, "dist", "cli.js")})`);
  if (!st.current && out.length === 0) out.push(`the hook entry in ${file} is outdated (matcher "${st.matcher}"): some tools may not be checked`);
  return out;
}

export interface IntegrityResult {
  ok: boolean;
  problems: string[];
  /** Files compared against the build list. */
  checked: number;
}

export function checkIntegrity(agent: string, o: HookEntryOptions & { dist?: string } = {}): IntegrityResult {
  const f = verifyFiles(o.dist);
  const problems = [...f.problems, ...hookEntryProblems(agent, o)];
  return { ok: problems.length === 0, problems, checked: f.checked };
}

/* -------------------------------------------------------------------- once per session */

export interface SessionCheckOptions extends HookEntryOptions {
  /** Where "this session was already checked" markers live (default ~/.cephalo/integrity). Agents cannot write there. */
  dir?: string;
  dist?: string;
  /** Checked at most once every this many ms for the same session. Default: once per session. */
  now?: number;
}

const PRUNE_AFTER_MS = 48 * 3600 * 1000;

export interface SessionCheck {
  /** What the check found for this session (the stored result on later calls). */
  problems: string[];
  /** True on the first call of the session, when the check actually ran: the moment to warn. */
  first: boolean;
}

/**
 * The check for the first hook call of a session. The result is stored in a small marker, so later calls in the session
 * cost nothing and still know the outcome (fail-closed mode keeps blocking while it is bad). Never throws.
 */
export function sessionStartCheck(agent: string, payload: { session_id?: unknown; cwd?: unknown }, o: SessionCheckOptions = {}): SessionCheck {
  try {
    const dir = o.dir ?? path.join(cephaloDir(), "integrity");
    const key = `${agent}-${sessionKey(payload.session_id, payload.cwd)}`.replace(/[^A-Za-z0-9_.-]/g, "_");
    const marker = path.join(dir, `${key}.json`);
    if (fs.existsSync(marker)) {
      try {
        const m = JSON.parse(fs.readFileSync(marker, "utf8"));
        return { problems: Array.isArray(m?.problems) ? m.problems.filter((p: unknown) => typeof p === "string") : [], first: false };
      } catch {
        return { problems: [], first: false };
      }
    }
    const res = checkIntegrity(agent, o);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ ts: new Date(o.now ?? Date.now()).toISOString(), ok: res.ok, checked: res.checked, problems: res.problems }));
    const now = o.now ?? Date.now();
    for (const name of fs.readdirSync(dir)) {
      try {
        const f = path.join(dir, name);
        if (now - fs.statSync(f).mtimeMs > PRUNE_AFTER_MS) fs.unlinkSync(f);
      } catch {
        /* pruning is best effort */
      }
    }
    return { problems: res.problems, first: true };
  } catch {
    return { problems: [], first: false };
  }
}

/** The text shown to the user when the check fails. */
export function integrityWarning(problems: string[]): string {
  const shown = problems.slice(0, 5).map((p) => `  - ${p}`).join("\n");
  const more = problems.length > 5 ? `\n  ...and ${problems.length - 5} more` : "";
  return `⚠ CEPHALO INTEGRITY CHECK FAILED: the guard that checks this agent's tool calls may have been changed or switched off.\n${shown}${more}\nRun "cephalo doctor" in a terminal you trust. Reinstall with "npm run build" and "cephalo install" if you did not make these changes.`;
}
