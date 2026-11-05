import { setConfigValue } from "./config.js";
import { octopusRows } from "./banner.js";
import { themeChoice } from "./term.js";
import { DEFAULT_THEME, THEMES, getTheme, isThemeName, makePainter, mix, themeNames, type Env, type Mode, type Painter } from "./theme.js";

export const THEME_USAGE = `Usage: cephalo theme [list | preview [name] | set <name> | reset]

  list            the color schemes, and which one is in use
  preview [name]  the logo and a few sample lines in one scheme (all of them if no name)
  set <name>      use this scheme from now on (saved in ~/.cephalo/config.yml)
  reset           back to the default (${DEFAULT_THEME})

Schemes: ${themeNames().join(", ")}.
For one run only: CEPHALO_THEME=glow cephalo log
Light terminal? Cephalo reads COLORFGBG; if it guesses wrong: CEPHALO_BACKGROUND=light.
No color at all: NO_COLOR=1 (the output then has no escape sequences).
Hook output (cephalo hook ...) is JSON and never has color, whatever the scheme.
`;

export interface ThemeResult {
  lines: string[];
  exitCode: number;
}

/** A one-line preview: the wordmark gradient and the three labels. With no color it is just the labels. */
export function swatch(p: Painter): string {
  const { from, to } = p.palette;
  const bar = p.level === 0 ? "" : [...Array(12).keys()].map((i) => p.rgb(mix(from, to, i / 11), undefined, "█")).join("") + "  ";
  return `${bar}${p.label("allow", "ALLOW")}  ${p.label("block", "BLOCK")}  ${p.label("ask", "ASK")}`;
}

/** A small sample of what output looks like in a scheme. */
export function sampleLines(p: Painter): string[] {
  return [
    `${p.role("dim", "12:01:09")}  ${p.label("allow", "ALLOW")}  claude/Bash  npm test`,
    `${p.role("dim", "12:01:14")}  ${p.label("block", "BLOCK")}  claude/Bash ${p.role("accent", "[no-force-push]")}  git push --force origin main`,
    `${p.role("dim", "12:01:20")}  ${p.label("ask", "ASK")}    claude/Bash ${p.role("accent", "[ask-push]")}  git push origin feature`,
    `${p.role("dim", "12:01:31")}  ${p.label("allow", "ALLOW")}  claude/Bash ${p.role("shadow", "{would block: no-curl-sh}")}  curl example.com`,
    `${p.role("ok", "✓")} Rules file: ok   ${p.role("warn", "!")} Settings: shadow mode ON   ${p.role("fail", "✗")} Hook entry: missing`,
  ];
}

/** The logo plus samples for one scheme, as lines. */
export function previewLines(name: string, env: Env, level: 0 | 1 | 2 | 3, mode: Mode): string[] {
  const t = getTheme(name);
  const p = makePainter({ env, theme: t.name, level, mode });
  const out = [p.role("heading", `${t.name}`) + p.role("dim", `  ${t.description}`)];
  if (p.level > 0) out.push(...octopusRows(p).map((r) => "  " + r));
  out.push(...sampleLines(p).map((l) => "  " + l));
  return out;
}

export function themeCommand(args: string[], o: { env?: Env; configFile?: string; level?: 0 | 1 | 2 | 3; mode?: Mode } = {}): ThemeResult {
  const env = o.env ?? process.env;
  const sub = args[0] ?? "list";
  const probe = makePainter({ env, ...(o.level !== undefined ? { level: o.level } : {}), ...(o.mode ? { mode: o.mode } : {}) });
  const level = probe.level;
  const mode = probe.mode;

  if (sub === "list") {
    const cur = themeChoice(env, o.configFile);
    const lines = THEMES.flatMap((t) => {
      const p = makePainter({ env, theme: t.name, level, mode });
      return [`${t.name === cur.name ? "*" : " "} ${t.name.padEnd(7)} ${t.description}`, `    ${swatch(p)}`];
    });
    lines.push("", `In use: ${cur.name} (${cur.source === "CEPHALO_THEME" ? "CEPHALO_THEME, this run only" : cur.source === "config" ? "your settings" : "the default"}). Background: ${mode}. Colors: ${level === 0 ? "off" : level === 1 ? "16" : level === 2 ? "256" : "24-bit"}.`);
    return { lines, exitCode: 0 };
  }
  if (sub === "preview") {
    const want = args[1];
    if (want !== undefined && !isThemeName(want)) return { lines: [`cephalo: no scheme called "${want}". Schemes: ${themeNames().join(", ")}.`], exitCode: 1 };
    const names = want ? [want] : themeNames();
    const lines: string[] = [];
    names.forEach((n, i) => {
      if (i > 0) lines.push("");
      lines.push(...previewLines(n, env, level, mode));
    });
    if (level === 0) lines.push("", "Color is off here (NO_COLOR, a pipe, or a terminal without color), so the schemes look the same. ALLOW, BLOCK and ASK are always words.");
    return { lines, exitCode: 0 };
  }
  if (sub === "set") {
    const name = args[1];
    if (!isThemeName(name)) return { lines: [name ? `cephalo: no scheme called "${name}". Schemes: ${themeNames().join(", ")}.` : "cephalo: theme set needs a name.", ...THEME_USAGE.trimEnd().split("\n").slice(0, 1)], exitCode: 1 };
    try {
      const { backup } = setConfigValue("theme", name, o.configFile);
      return { lines: [`Theme set to ${name}.${backup ? ` Backup of the old settings: ${backup}` : ""}`, ...previewLines(name, env, level, mode).slice(1, 0)], exitCode: 0 };
    } catch (e) {
      return { lines: [`cephalo: ${(e as Error).message}`], exitCode: 1 };
    }
  }
  if (sub === "reset") {
    try {
      const { backup } = setConfigValue("theme", DEFAULT_THEME, o.configFile);
      return { lines: [`Theme reset to ${DEFAULT_THEME}.${backup ? ` Backup of the old settings: ${backup}` : ""}`], exitCode: 0 };
    } catch (e) {
      return { lines: [`cephalo: ${(e as Error).message}`], exitCode: 1 };
    }
  }
  return { lines: [THEME_USAGE.trimEnd()], exitCode: 1 };
}
