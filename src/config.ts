import fs from "node:fs";
import path from "node:path";
import { isMap, parseDocument, Document } from "yaml";
import { cephaloDir } from "./rules.js";
import { isThemeName, themeNames } from "./theme.js";

/**
 * Cephalo's own settings, in ~/.cephalo/config.yml. The file does not exist until you set something. Agents cannot
 * write it (it is in the protect-cephalo-policy rule and the shell tamper rules): an agent that could turn off
 * fail-closed mode or turn on shadow mode could switch off the seatbelt.
 */
export interface Config {
  /** When the hook crashes, times out or gets input it cannot read: block the call instead of letting it through. */
  failClosed: boolean;
  /** Shadow mode for every rule except Cephalo's own protections: log what would have been blocked, and block nothing. */
  shadow: boolean;
  /** What an `ask` rule does when the agent cannot show a prompt (Hermes, Codex, Cursor): block or allow. */
  askDefault: "block" | "allow";
  /** Seconds the hook may take before fail-closed mode gives up and blocks. */
  hookTimeoutSeconds: number;
  /** Color scheme for the CLI's own output (never the hook): reef, abyss, coral, glow, ink. Unset means reef. CEPHALO_THEME overrides it for one run. */
  theme?: string;
}

export const DEFAULT_CONFIG: Config = { failClosed: false, shadow: false, askDefault: "block", hookTimeoutSeconds: 8 };

export interface ConfigKey {
  /** Name on the command line. */
  name: string;
  /** Key in config.yml. */
  yaml: string;
  kind: "bool" | "ask" | "seconds" | "theme";
  description: string;
}

export const CONFIG_KEYS: ConfigKey[] = [
  { name: "fail-closed", yaml: "fail_closed", kind: "bool", description: "Block (instead of allow) when the hook crashes, times out or gets input it cannot read. Off by default: a broken hook then stops your agent's tool calls." },
  { name: "shadow", yaml: "shadow", kind: "bool", description: "Log what each rule would block or ask, and block nothing. Cephalo's own protections still apply." },
  { name: "ask-default", yaml: "ask_default", kind: "ask", description: "What an 'ask' rule does where the agent cannot show a prompt (Hermes, Codex, Cursor): block or allow." },
  { name: "hook-timeout", yaml: "hook_timeout_seconds", kind: "seconds", description: "Fail-closed mode: seconds the hook may take before it blocks the call (1 to 60)." },
  { name: "theme", yaml: "theme", kind: "theme", description: `Color scheme of the CLI's output: ${themeNames().join(", ")}. Also: cephalo theme set <name>.` },
];

export function configPath(): string {
  return path.join(cephaloDir(), "config.yml");
}

export interface ConfigState {
  config: Config;
  exists: boolean;
  /** Problems found in the file; the settings it could not read stay at their defaults. */
  problems: string[];
}

/** Read the settings. Never throws: a missing or broken file gives the defaults (and says why in `problems`). */
export function readConfig(file: string = configPath()): ConfigState {
  const config: Config = { ...DEFAULT_CONFIG };
  const problems: string[] = [];
  if (!fs.existsSync(file)) return { config, exists: false, problems };
  try {
    const doc = parseDocument(fs.readFileSync(file, "utf8"));
    if (doc.errors.length) {
      problems.push(`${file} is not valid YAML: ${doc.errors[0]!.message}`);
      return { config, exists: true, problems };
    }
    const j = (doc.toJSON() ?? {}) as Record<string, unknown>;
    const bool = (k: string, set: (v: boolean) => void) => {
      if (j[k] === undefined) return;
      if (typeof j[k] === "boolean") set(j[k] as boolean);
      else problems.push(`${k} must be true or false (got ${JSON.stringify(j[k])})`);
    };
    bool("fail_closed", (v) => (config.failClosed = v));
    bool("shadow", (v) => (config.shadow = v));
    if (j.ask_default !== undefined) {
      if (j.ask_default === "block" || j.ask_default === "allow") config.askDefault = j.ask_default;
      else problems.push(`ask_default must be block or allow (got ${JSON.stringify(j.ask_default)})`);
    }
    if (j.theme !== undefined) {
      if (isThemeName(j.theme)) config.theme = j.theme;
      else problems.push(`theme must be one of ${themeNames().join(", ")} (got ${JSON.stringify(j.theme)})`);
    }
    if (j.hook_timeout_seconds !== undefined) {
      const n = j.hook_timeout_seconds;
      if (typeof n === "number" && Number.isFinite(n) && n >= 1 && n <= 60) config.hookTimeoutSeconds = n;
      else problems.push(`hook_timeout_seconds must be a number from 1 to 60 (got ${JSON.stringify(n)})`);
    }
  } catch (e) {
    problems.push(`${file} cannot be read: ${(e as Error).message}`);
  }
  return { config, exists: true, problems };
}

export function loadConfig(file: string = configPath()): Config {
  return readConfig(file).config;
}

/** Parse a value typed on the command line for `key`. */
export function parseConfigValue(key: ConfigKey, text: string): { ok: true; value: boolean | string | number } | { ok: false; error: string } {
  const t = text.trim().toLowerCase();
  if (key.kind === "bool") {
    if (["on", "true", "yes", "1"].includes(t)) return { ok: true, value: true };
    if (["off", "false", "no", "0"].includes(t)) return { ok: true, value: false };
    return { ok: false, error: `${key.name} takes on or off` };
  }
  if (key.kind === "theme") return isThemeName(t) ? { ok: true, value: t } : { ok: false, error: `${key.name} takes one of: ${themeNames().join(", ")}` };
  if (key.kind === "ask") return t === "block" || t === "allow" ? { ok: true, value: t } : { ok: false, error: `${key.name} takes block or allow` };
  const n = Number(t);
  return Number.isFinite(n) && n >= 1 && n <= 60 ? { ok: true, value: n } : { ok: false, error: `${key.name} takes a number of seconds from 1 to 60` };
}

/**
 * Set one value in config.yml, keeping the comments and other keys. An existing file is backed up first. Refuses to touch a
 * file that is not valid YAML. Returns the backup path, if one was made.
 */
export function setConfigValue(yamlKey: string, value: boolean | string | number, file: string = configPath()): { backup?: string } {
  let doc: Document;
  let backup: string | undefined;
  if (fs.existsSync(file)) {
    doc = parseDocument(fs.readFileSync(file, "utf8"));
    if (doc.errors.length) throw new Error(`${file} is not valid YAML (${doc.errors[0]!.message}); fix it by hand, Cephalo will not overwrite it`);
    if (!isMap(doc.contents)) {
      if (doc.contents !== null) throw new Error(`${file} is not a YAML map; fix it by hand, Cephalo will not overwrite it`);
      doc = new Document({});
    }
    backup = `${file}.cephalo-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(file, backup);
  } else {
    doc = new Document({});
    doc.commentBefore = " Cephalo settings. Created by `cephalo config set`. Agents cannot edit this file.";
  }
  doc.set(yamlKey, value);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, doc.toString({ lineWidth: 0 }), "utf8");
  return backup ? { backup } : {};
}
