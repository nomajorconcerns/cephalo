import fs from "node:fs";
import { sanitize } from "./watch.js";
import { scanText } from "./tripwire/detect.js";
import { clearStates, listStates, loadTripPolicy, serializeTripPolicy, tripPolicyPath, tripStateDir, type TripMode, type TripPolicy } from "./tripwire/state.js";

export interface TripCmdOptions {
  policyFile?: string;
  dir?: string;
}

const short = (s: string) => (s.length > 18 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s);

/** One-line summary for `doctor`. */
export function tripSummary(o: TripCmdOptions = {}): { mode: TripMode; alert: number; watch: number } {
  const states = listStates(o.dir ?? tripStateDir());
  return { mode: loadTripPolicy(o.policyFile ?? tripPolicyPath()).mode, alert: states.filter((s) => s.level === "alert").length, watch: states.filter((s) => s.level === "watch").length };
}

export function tripStatus(o: TripCmdOptions = {}): { lines: string[]; exitCode: number } {
  const file = o.policyFile ?? tripPolicyPath();
  const policy = loadTripPolicy(file);
  const states = listStates(o.dir ?? tripStateDir());
  const lines = [
    `Prompt-injection tripwire: ${policy.mode}   (${file})`,
    policy.mode === "enforce"
      ? "  After text that looks like an injection is read, network, credential, persistence and write-type MCP actions are blocked in that session."
      : policy.mode === "warn"
        ? "  Detections are logged and warned about; nothing is blocked."
        : "  Off: tool output is not scanned.",
    "",
  ];
  if (states.length === 0) {
    lines.push("No sessions have tripped the wire.");
    return { lines, exitCode: 0 };
  }
  for (const s of states) {
    lines.push(`${s.level === "alert" ? "ALERT" : "watch"}  ${s.agent}  session ${short(s.session)}  first seen ${s.firstSeen}`);
    for (const e of s.events.slice(-5)) {
      lines.push(`  ${e.ts}  ${e.tool}  [${e.level}]`);
      for (const f of e.findings.filter((x) => x.severity !== "low")) lines.push(`      ${f.severity}  ${f.id}: ${sanitize(f.label)}   "${sanitize(f.excerpt)}"`);
    }
  }
  lines.push("", s_hint(states.some((s) => s.level === "alert")));
  return { lines, exitCode: states.some((s) => s.level === "alert") ? 2 : 0 };
}

const s_hint = (alert: boolean) => (alert ? "Review the text above. If it was a false alarm (for example you were reading a document about prompt injection), release the sessions with: cephalo tripwire clear" : "Watch-level sessions are logged only; nothing is blocked.");

/** `cephalo tripwire scan <file>`: run the detector on any text. Exit code 2 = alert, 1 = watch, 0 = nothing. */
export function scanReport(text: string, label: string): { lines: string[]; exitCode: number } {
  const v = scanText(text);
  const lines = [`${label}: ${v.level === "none" ? "nothing suspicious found" : v.level.toUpperCase()}`];
  for (const f of v.findings) lines.push(`  ${f.severity.padEnd(6)} ${f.id}: ${sanitize(f.label)}${f.excerpt ? `   "${sanitize(f.excerpt)}"` : ""}`);
  if (v.level === "none" && v.findings.length) lines.push("  (the findings above are low severity and do not change anything on their own)");
  return { lines, exitCode: v.level === "alert" ? 2 : v.level === "watch" ? 1 : 0 };
}

export function planTripMode(mode: string, o: TripCmdOptions = {}): { ok: boolean; lines: string[]; mode?: TripMode } {
  if (mode !== "enforce" && mode !== "warn" && mode !== "off") return { ok: false, lines: ["Usage: cephalo tripwire mode enforce|warn|off   [--yes]"] };
  const cur = loadTripPolicy(o.policyFile ?? tripPolicyPath());
  return { ok: true, mode, lines: [`Switch the tripwire from ${cur.mode} to ${mode}.`] };
}

export function applyTripMode(mode: TripMode, o: TripCmdOptions = {}): string[] {
  const file = o.policyFile ?? tripPolicyPath();
  const cur = loadTripPolicy(file);
  if (fs.existsSync(file) && cur.mode === mode) return [`Already in ${mode} mode. Nothing changed.`];
  const out: string[] = [];
  if (fs.existsSync(file)) {
    const bk = `${file}.cephalo-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(file, bk);
    out.push(`Backup: ${bk}`);
  }
  const policy: TripPolicy = { mode };
  fs.mkdirSync(file.replace(/[\\/][^\\/]*$/, ""), { recursive: true });
  fs.writeFileSync(file, serializeTripPolicy(policy), "utf8");
  return [`Tripwire mode is now ${mode} (${file})`, ...out];
}

export function planClear(o: TripCmdOptions = {}): { lines: string[]; count: number } {
  const states = listStates(o.dir ?? tripStateDir());
  if (states.length === 0) return { lines: ["No tripped sessions. Nothing to clear."], count: 0 };
  return { lines: [`Release ${states.length} session(s): ${states.map((s) => `${s.agent}/${short(s.session)} (${s.level})`).join(", ")}`, "Their records are moved to a cleared/ folder, not deleted."], count: states.length };
}

export function applyClear(o: TripCmdOptions = {}): string[] {
  const moved = clearStates(undefined, o.dir ?? tripStateDir());
  return [`Released ${moved.length} session(s). Risky actions are allowed again in them.`];
}
