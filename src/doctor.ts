import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { auditPath } from "./audit.js";
import { runHook } from "./hooks.js";
import { claudeSettingsPath, hermesConfigPath, projectRoot, HERMES_CMD_RE } from "./install.js";
import { DEFAULT_RULES, defaultRulesPath, parseRules, type Rule } from "./rules.js";
import { claudeStatus, hermesStatus, type HookStatus } from "./status.js";

export type Level = "ok" | "warn" | "fail" | "info";

export interface Check {
  level: Level;
  name: string;
  detail: string;
  fix?: string;
}

export interface DoctorOptions {
  rulesFile?: string;
  auditFile?: string;
  claudeFile?: string;
  hermesFile?: string;
  abs?: string;
  /** Returns the output of `hermes hooks list`, or null if unavailable. Injectable for tests. */
  hermesList?: () => string | null;
}

function defaultHermesList(): string | null {
  try {
    const r = spawnSync("hermes", ["hooks", "list"], { encoding: "utf8", timeout: 10000, windowsHide: true, shell: process.platform === "win32" });
    if (r.error || r.status !== 0) return null;
    return `${r.stdout ?? ""}`;
  } catch {
    return null;
  }
}

/** Pull the cli.js path out of "node <path> hook <agent>". */
function commandTarget(command: string | undefined): string | undefined {
  const m = command?.match(/^node\s+"?(.+?cli\.js)"?\s+hook\s/);
  return m?.[1];
}

function checkHook(name: "Claude Code" | "Hermes", st: HookStatus, file: string, installCmd: string, out: Check[]): void {
  if (st.error) {
    out.push({ level: "fail", name: `${name} hook`, detail: `cannot read ${file}: ${st.error}`, fix: "Fix the file by hand; Cephalo will not touch it while it is invalid." });
    return;
  }
  if (!st.fileExists) {
    out.push({
      level: name === "Claude Code" ? "warn" : "info",
      name: `${name} hook`,
      detail: `${file} not found${name === "Hermes" ? " (Hermes not installed?)" : ""}`,
      fix: name === "Claude Code" ? installCmd : undefined,
    });
    return;
  }
  if (!st.installed) {
    out.push({ level: "fail", name: `${name} hook`, detail: `not installed in ${file}. Calls are NOT being checked.`, fix: installCmd });
    return;
  }
  if (!st.current) {
    out.push({ level: "warn", name: `${name} hook`, detail: `installed but outdated or pointing elsewhere (matcher "${st.matcher}", command "${st.command}")`, fix: installCmd });
  } else {
    out.push({ level: "ok", name: `${name} hook`, detail: `installed and current (${file})` });
  }
  const target = commandTarget(st.command);
  if (target) {
    if (fs.existsSync(target)) out.push({ level: "ok", name: `${name} hook target`, detail: `${target} exists` });
    else out.push({ level: "fail", name: `${name} hook target`, detail: `${target} is missing, the hook will crash (and fail open)`, fix: "cd to the cephalo project and run: npm run build" });
  }
}

export function runDoctor(o: DoctorOptions = {}): { checks: Check[]; exitCode: number } {
  const abs = o.abs ?? projectRoot();
  const rulesFile = o.rulesFile ?? defaultRulesPath();
  const auditFile = o.auditFile ?? auditPath();
  const claudeFile = o.claudeFile ?? claudeSettingsPath();
  const hermesFile = o.hermesFile ?? hermesConfigPath();
  const checks: Check[] = [];

  checks.push({ level: "info", name: "Environment", detail: `node ${process.version} on ${process.platform}, project ${abs}` });

  // Rules (read-only: never create the file here)
  let rules: Rule[] = [];
  if (!fs.existsSync(rulesFile)) {
    checks.push({ level: "warn", name: "Rules file", detail: `${rulesFile} does not exist yet (created from defaults on first use)`, fix: "cephalo init" });
  } else {
    try {
      const parsed = parseRules(fs.readFileSync(rulesFile, "utf8"));
      rules = parsed.rules;
      if (parsed.problems.length) {
        checks.push({ level: "fail", name: "Rules file", detail: `${rulesFile}: ${parsed.problems.join("; ")}` });
      } else {
        checks.push({ level: "ok", name: "Rules file", detail: `${rules.length} rules loaded from ${rulesFile}` });
      }
      const have = new Set(rules.map((r) => r.id));
      const missing = DEFAULT_RULES.map((r) => r.id).filter((id) => !have.has(id));
      if (missing.length) {
        checks.push({ level: "warn", name: "Default rules", detail: `missing from your rules file: ${missing.join(", ")}`, fix: "Add them back, or rename rules.yml so Cephalo regenerates it" });
      }
    } catch (e) {
      checks.push({ level: "fail", name: "Rules file", detail: `${rulesFile} cannot be parsed: ${(e as Error).message}` });
    }
  }

  // Self-test with the user's real rules, in-process, with a throwaway audit file (nothing is written to the real log)
  if (rules.length) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cephalo-doctor-"));
    try {
      const opts = { rules, auditFile: path.join(tmp, "audit.jsonl") };
      const deny = runHook("claude", JSON.stringify({ tool_name: "Bash", tool_input: { command: "DROP TABLE doctor_probe" } }), opts);
      const allow = runHook("claude", JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }), opts);
      const hdeny = runHook("hermes", JSON.stringify({ tool_name: "terminal", tool_input: { command: "DROP TABLE doctor_probe" } }), opts);
      const good = deny.includes('"permissionDecision":"deny"') && allow === "" && hdeny.includes('"action":"block"');
      checks.push(
        good
          ? { level: "ok", name: "Self-test", detail: "your rules block DROP TABLE and allow ls, for both Claude and Hermes payloads" }
          : { level: "fail", name: "Self-test", detail: "your rules did not block 'DROP TABLE' (is no-drop removed or edited?)" },
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // Audit log writable (checks permissions only; writes nothing)
  try {
    const dir = path.dirname(auditFile);
    let probe = dir;
    while (!fs.existsSync(probe)) probe = path.dirname(probe);
    fs.accessSync(fs.existsSync(auditFile) ? auditFile : probe, fs.constants.W_OK);
    checks.push({ level: "ok", name: "Audit log", detail: `writable (${auditFile})` });
  } catch (e) {
    checks.push({ level: "fail", name: "Audit log", detail: `${auditFile} is not writable: ${(e as Error).message}` });
  }

  // Hooks
  const cs = claudeStatus(claudeFile, abs);
  checkHook("Claude Code", cs, claudeFile, "cephalo install claude", checks);
  const hs = hermesStatus(hermesFile, abs);
  checkHook("Hermes", hs, hermesFile, "cephalo install hermes", checks);

  // Hermes consent (a hook that is not allowlisted is silently skipped by Hermes)
  if (hs.installed) {
    const listing = (o.hermesList ?? defaultHermesList)();
    const line = listing?.split(/\r?\n/).find((l) => HERMES_CMD_RE.test(l));
    if (line) {
      if (/not allowlisted/i.test(line)) {
        checks.push({ level: "fail", name: "Hermes approval", detail: "Hermes lists the hook as NOT allowlisted, so it skips it and nothing is blocked", fix: "Start an interactive `hermes` and accept the hook prompt, then re-run: cephalo doctor" });
      } else if (/allowlisted/i.test(line)) {
        checks.push({ level: "ok", name: "Hermes approval", detail: "hook is allowlisted" });
      } else {
        checks.push({ level: "warn", name: "Hermes approval", detail: `could not interpret: ${line.trim()}`, fix: "Run: hermes hooks list" });
      }
    } else {
      const allow = path.join(path.dirname(hermesFile), "shell-hooks-allowlist.json");
      const approved = fs.existsSync(allow) && fs.readFileSync(allow, "utf8").includes("hook hermes");
      checks.push(
        approved
          ? { level: "ok", name: "Hermes approval", detail: `command found in ${allow} (could not run 'hermes hooks list' to double check)` }
          : { level: "warn", name: "Hermes approval", detail: "could not confirm approval (hermes CLI not runnable and no allowlist entry found)", fix: "Run: hermes hooks list   (should not say 'not allowlisted')" },
      );
    }
  }

  const exitCode = checks.some((c) => c.level === "fail") ? 1 : 0;
  return { checks, exitCode };
}

const MARK: Record<Level, string> = { ok: "✓", warn: "!", fail: "✗", info: "-" };

export function formatChecks(checks: Check[]): string[] {
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`${MARK[c.level]} ${c.name}: ${c.detail}`);
    if (c.fix) lines.push(`    fix: ${c.fix}`);
  }
  const fails = checks.filter((c) => c.level === "fail").length;
  const warns = checks.filter((c) => c.level === "warn").length;
  lines.push("");
  lines.push(fails ? `${fails} problem(s), ${warns} warning(s).` : warns ? `No problems, ${warns} warning(s).` : "All good.");
  return lines;
}
