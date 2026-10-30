import os from "node:os";
import path from "node:path";
import { LINUX_RULES, MACOS_RULES, WINDOWS_RULES } from "./platform-rules.js";
import type { Rule } from "./rules.js";

export type PlatformId = "win32" | "darwin" | "linux";

export interface PlatformEnv {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/**
 * Everything that differs per operating system lives behind this interface:
 * where agent configs and Cephalo's own data live, how to spawn the `hermes` CLI,
 * and how paths/commands are normalized before rules are matched.
 */
export interface PlatformAdapter {
  id: PlatformId;
  label: string;
  /** Claude Code user settings file. */
  claudeSettingsPath(p?: PlatformEnv): string;
  /** Hermes config.yaml. */
  hermesConfigPath(p?: PlatformEnv): string;
  /** Cephalo's data dir (rules.yml, audit.jsonl). Same relative location on every OS so data never moves. */
  dataDir(p?: PlatformEnv): string;
  /** Extra spawnSync options needed to run npm-style CLI shims (hermes.cmd on Windows). */
  spawnOptions(): { shell: boolean; windowsHide: boolean };
  /** Built-in rules that only make sense on this OS. Applied at runtime, never written to rules.yml. */
  rules(): Rule[];
  /** Canonical form of a file path for rule matching: forward slashes, ~ and env vars expanded, dot segments resolved. */
  normalizePath(raw: string, p?: PlatformEnv): string;
  /** A de-obfuscated variant of a shell command (shell escapes/empty quotes removed). Rules are matched against the raw AND this variant. */
  normalizeCommand(raw: string): string;
}

const homeOf = (p?: PlatformEnv) => p?.home ?? os.homedir();
const envOf = (p?: PlatformEnv) => p?.env ?? process.env;

/** Expand `~`, `$HOME`, `${HOME}` against the given home. */
function expandPosixHome(raw: string, home: string): string {
  return raw
    .replace(/^~(?=$|[\\/])/, home)
    .replace(/^\$\{HOME\}|^\$HOME(?![A-Za-z0-9_])/, home);
}

function cleanSlashes(s: string): string {
  const unc = s.startsWith("//") && !s.startsWith("///");
  const n = path.posix.normalize(s.replace(/\/{2,}/g, "/"));
  return unc ? "/" + n : n;
}

/** Shared POSIX shell de-obfuscation: line continuations, empty quote pairs, backslash-escaped letters. */
function normalizePosixCommand(raw: string): string {
  return raw
    .replace(/\\\r?\n/g, " ")
    .replace(/(?<=\S)(''|"")(?=\S)/g, "") // r''m -> rm
    .replace(/(?<=[A-Za-z0-9])\\(?=[A-Za-z])/g, "") // r\m -> rm
    .replace(/(^|[\s;&|(])\\(?=[A-Za-z])/g, "$1"); // \rm -> rm
}

const win32: PlatformAdapter = {
  id: "win32",
  label: "Windows",
  claudeSettingsPath: (p) => path.join(homeOf(p), ".claude", "settings.json"),
  hermesConfigPath: (p) => {
    const base = envOf(p).LOCALAPPDATA ?? path.join(homeOf(p), "AppData", "Local");
    return path.join(base, "hermes", "config.yaml");
  },
  dataDir: (p) => path.join(homeOf(p), ".cephalo"),
  spawnOptions: () => ({ shell: true, windowsHide: true }),
  rules: () => WINDOWS_RULES,
  normalizePath(raw, p) {
    const e = envOf(p);
    const home = homeOf(p);
    let s = raw.trim();
    s = s.replace(/^\\\\\?\\/, ""); // \\?\C:\x
    s = s.replace(/^~(?=$|[\\/])/, home);
    s = s.replace(/%([A-Za-z0-9_]+)%/g, (m, k: string) => e[k] ?? e[k.toUpperCase()] ?? m);
    s = s.replace(/\$env:([A-Za-z0-9_]+)/gi, (m, k: string) => e[k] ?? e[k.toUpperCase()] ?? m);
    s = s.replace(/\\/g, "/");
    // Drive-letter paths: keep the drive prefix, normalize the rest
    const m = s.match(/^([A-Za-z]:)(\/.*)?$/);
    if (m) return m[1] + cleanSlashes(m[2] ?? "/");
    return cleanSlashes(s);
  },
  normalizeCommand(raw) {
    return raw
      .replace(/\^(?=[^\r\n])/g, "") // cmd.exe escape: r^d /s
      .replace(/`(?=\S)/g, "") // PowerShell escape: Remove`-Item
      .replace(/(?<=\S)(''|"")(?=\S)/g, "");
  },
};

const darwin: PlatformAdapter = {
  id: "darwin",
  label: "macOS",
  claudeSettingsPath: (p) => path.join(homeOf(p), ".claude", "settings.json"),
  hermesConfigPath: (p) => path.join(homeOf(p), ".hermes", "config.yaml"),
  dataDir: (p) => path.join(homeOf(p), ".cephalo"),
  spawnOptions: () => ({ shell: false, windowsHide: false }),
  rules: () => MACOS_RULES,
  normalizePath(raw, p) {
    let s = expandPosixHome(raw.trim(), homeOf(p));
    s = cleanSlashes(s.replace(/\\/g, "/"));
    // /etc, /var, /tmp are symlinks into /private on macOS
    return s.replace(/^\/private(?=\/(etc|var|tmp)(\/|$))/, "");
  },
  normalizeCommand: normalizePosixCommand,
};

const linux: PlatformAdapter = {
  id: "linux",
  label: "Linux",
  claudeSettingsPath: (p) => path.join(homeOf(p), ".claude", "settings.json"),
  hermesConfigPath: (p) => path.join(homeOf(p), ".hermes", "config.yaml"),
  dataDir: (p) => path.join(homeOf(p), ".cephalo"),
  spawnOptions: () => ({ shell: false, windowsHide: false }),
  rules: () => LINUX_RULES,
  normalizePath(raw, p) {
    return cleanSlashes(expandPosixHome(raw.trim(), homeOf(p)).replace(/\\/g, "/"));
  },
  normalizeCommand: normalizePosixCommand,
};

const ADAPTERS: Record<PlatformId, PlatformAdapter> = { win32, darwin, linux };

/** Adapter for a Node `process.platform` value. Unknown POSIX systems (freebsd, etc.) use the Linux adapter. */
export function getPlatform(id: string = process.platform): PlatformAdapter {
  return ADAPTERS[id as PlatformId] ?? linux;
}

export const ALL_PLATFORMS: PlatformAdapter[] = [win32, darwin, linux];
