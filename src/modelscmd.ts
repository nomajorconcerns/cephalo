import fs from "node:fs";
import path from "node:path";
import { ROLES, loadModelsConfig, modelsConfigPath, normalizeTag, requiredTags, serializeModelsConfig, type JudgeMode, type ModelsConfig } from "./models/config.js";
import { judgeCachePath, judgeCommand } from "./judge/decide.js";
import { SIGNAL_IDS, findSignals } from "./judge/signals.js";
import { ollamaStatus, type FetchLike } from "./models/ollama.js";

export interface ModelsCmdOptions {
  file?: string;
  fetch?: FetchLike;
  now?: () => number;
}

const haveTag = (installed: string[], tag: string) => installed.some((i) => normalizeTag(i) === normalizeTag(tag));

/** One-line summary for `doctor`. */
export async function modelsSummary(o: ModelsCmdOptions = {}): Promise<{ enabled: boolean; reachable: boolean; missing: string[] }> {
  const c = loadModelsConfig(o.file, () => {});
  if (!c.enabled) return { enabled: false, reachable: false, missing: [] };
  const s = await ollamaStatus({ host: c.host, timeoutMs: c.timeoutMs, fetch: o.fetch });
  return { enabled: true, reachable: s.reachable, missing: s.reachable ? requiredTags(c).filter((r) => !haveTag(s.installed, r.tag)).map((r) => r.tag) : [] };
}

/** `cephalo models status`: config plus what the local Ollama has. Exit 0 = ready (or off), 1 = something to fix. */
export async function modelsStatus(o: ModelsCmdOptions = {}): Promise<{ lines: string[]; exitCode: number }> {
  const file = o.file ?? modelsConfigPath();
  const c = loadModelsConfig(file);
  const s = await ollamaStatus({ host: c.host, timeoutMs: c.timeoutMs, fetch: o.fetch });
  const lines = [
    `Local-model judge: ${c.enabled ? `enabled, ${c.mode} mode` : "off"}   (${fs.existsSync(file) ? file : `${file}, not created yet; defaults shown`})`,
    `  Ollama ${c.host}: ${s.reachable ? `reachable${s.version ? `, version ${s.version}` : ""}` : `not reachable (${s.error})`}`,
    "",
  ];
  const missing: string[] = [];
  for (const role of ROLES) {
    lines.push(`  ${role}`);
    c.roles[role].forEach((tag, i) => {
      const state = !s.reachable ? "unknown" : haveTag(s.installed, tag) ? "installed" : "missing";
      if (state === "missing" && !missing.includes(tag)) missing.push(tag);
      lines.push(`    ${i === 0 ? "first " : "backup"}  ${tag.padEnd(22)} ${state}`);
    });
  }
  lines.push("");
  if (!s.reachable) lines.push("Start Ollama (or install it from ollama.com), then run this again.");
  else if (missing.length) lines.push(`Missing: ${missing.join(", ")}. Run: cephalo models pull   (it prints the commands; it does not run them)`);
  else lines.push("All configured models are installed.");
  if (!c.enabled) lines.push("The judge is off, so Cephalo never calls a model. Turn it on with: cephalo models enable");
  return { lines, exitCode: !c.enabled || (s.reachable && missing.length === 0) ? 0 : 1 };
}

/** `cephalo models pull`: print the commands for missing models. Cephalo downloads nothing itself. */
export async function modelsPullPlan(o: ModelsCmdOptions = {}): Promise<{ lines: string[]; exitCode: number }> {
  const c = loadModelsConfig(o.file);
  const s = await ollamaStatus({ host: c.host, timeoutMs: c.timeoutMs, fetch: o.fetch });
  const need = requiredTags(c).filter((r) => !s.reachable || !haveTag(s.installed, r.tag));
  if (s.reachable && need.length === 0) return { lines: ["Nothing to pull: every configured model is installed."], exitCode: 0 };
  const lines = [
    s.reachable ? "Models to download (run these yourself; Cephalo does not download anything):" : `Ollama is not reachable (${s.error}); these are all configured models. Run the ones you do not have:`,
    "",
    ...need.map((r) => `  ollama pull ${r.tag}      # ${r.roles.join(", ")}`),
  ];
  return { lines, exitCode: 0 };
}

export function planModelsEnabled(arg: "enable" | "disable", o: ModelsCmdOptions = {}): { lines: string[]; changed: boolean } {
  const file = o.file ?? modelsConfigPath();
  const c = loadModelsConfig(file);
  const want = arg === "enable";
  if (c.enabled === want && fs.existsSync(file)) return { lines: [`The local-model judge is already ${want ? "enabled" : "off"}. Nothing to change.`], changed: false };
  const lines = [`Will ${fs.existsSync(file) ? "update" : "create"} ${file} and set enabled: ${want}.`];
  if (fs.existsSync(file)) lines.push("The existing file is backed up first.");
  if (want) lines.push("Cephalo will then send ambiguous commands and flagged text to the Ollama on this machine for a second opinion. Nothing leaves this computer.");
  return { lines, changed: true };
}

export function planModelsMode(arg: string, o: ModelsCmdOptions = {}): { lines: string[]; ok: boolean; mode?: JudgeMode } {
  if (arg !== "warn" && arg !== "enforce") return { lines: ["Usage: cephalo models mode warn|enforce"], ok: false };
  const c = loadModelsConfig(o.file ?? modelsConfigPath());
  if (c.mode === arg) return { lines: [`Mode is already ${arg}. Nothing to change.`], ok: false };
  return {
    ok: true,
    mode: arg,
    lines: [
      arg === "enforce"
        ? "Will set mode: enforce. When the local model is confident a risky command is harmful, Cephalo blocks it. Small models make mistakes, so watch the log (cephalo log) for a while in warn mode first."
        : "Will set mode: warn. The local model's block verdicts are logged in the audit note but the command still runs.",
    ],
  };
}

export function applyModelsMode(mode: JudgeMode, o: ModelsCmdOptions = {}): string[] {
  return writeConfig((c) => ({ ...c, mode }), `mode: ${mode}`, o);
}

export function applyModelsEnabled(arg: "enable" | "disable", o: ModelsCmdOptions = {}): string[] {
  return writeConfig((c) => ({ ...c, enabled: arg === "enable" }), `enabled: ${arg === "enable"}`, o);
}

/** Rewrite models.yml with a change, backing the old file up first. Comments in the old file are not kept (the backup has them). */
function writeConfig(change: (c: ModelsConfig) => ModelsConfig, what: string, o: ModelsCmdOptions): string[] {
  const file = o.file ?? modelsConfigPath();
  const lines: string[] = [];
  const c: ModelsConfig = loadModelsConfig(file, () => {});
  if (fs.existsSync(file)) {
    const stamp = new Date((o.now ?? Date.now)()).toISOString().replace(/[:.]/g, "-");
    const backup = `${file}.cephalo-backup-${stamp}`;
    fs.copyFileSync(file, backup);
    lines.push(`Backed up the old file to ${backup}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeModelsConfig(change(c)));
  lines.push(`Saved ${file} with ${what}.`);
  return lines;
}

/** `cephalo models judge "<command>"`: ask the decider about one command, whatever the on/off setting, and show the answer. */
export async function judgeReport(command: string, o: ModelsCmdOptions & { cacheFile?: string } = {}): Promise<{ lines: string[]; exitCode: number }> {
  const c = loadModelsConfig(o.file);
  const signals = findSignals(command);
  const lines = [`Command: ${command}`, `Risk signals: ${signals.length ? signals.join(", ") : "none"}`];
  if (signals.length === 0) {
    lines.push("No risk signal, so Cephalo would not ask a model about this command. (Signals: " + SIGNAL_IDS.join(", ") + ")");
    return { lines, exitCode: 0 };
  }
  const j = await judgeCommand(command, { config: c, fetch: o.fetch, cacheFile: o.cacheFile ?? judgeCachePath() });
  if (!j) {
    lines.push(`No answer: no decider model (${c.roles.decider.join(", ")}) gave a usable reply within ${c.timeoutMs} ms. Check: cephalo models status`);
    return { lines, exitCode: 1 };
  }
  lines.push(`Model: ${j.model}${j.cached ? " (cached answer)" : `   ${j.ms} ms`}`, `Verdict: ${j.verdict}${j.reason ? ` - ${j.reason}` : ""}`);
  lines.push(
    j.verdict === "block"
      ? c.enabled
        ? c.mode === "enforce" ? "Cephalo would block this." : "Mode is warn: Cephalo would log this and let it run."
        : "The judge is off, so Cephalo would not act on this."
      : "Cephalo would let this run.",
  );
  return { lines, exitCode: 0 };
}
