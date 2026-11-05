import { loadConfig } from "./config.js";
import { DEFAULT_THEME, isThemeName, makePainter, type Env, type Painter, type PainterOptions } from "./theme.js";

/** Which theme is in use and why: CEPHALO_THEME for this run, else config.yml, else the default. */
export function themeChoice(env: Env = process.env, configFile?: string): { name: string; source: "CEPHALO_THEME" | "config" | "default" } {
  const fromEnv = env.CEPHALO_THEME?.trim().toLowerCase();
  if (isThemeName(fromEnv)) return { name: fromEnv, source: "CEPHALO_THEME" };
  let fromConfig: string | undefined;
  try {
    fromConfig = loadConfig(configFile).theme;
  } catch {
    /* a broken settings file never breaks output */
  }
  return isThemeName(fromConfig) ? { name: fromConfig, source: "config" } : { name: DEFAULT_THEME, source: "default" };
}

/**
 * The painter for the CLI's own output: the chosen theme at the depth this terminal can show (none for a pipe, NO_COLOR or CI-style
 * dumb terminals). `cephalo hook ...` must never call this: hook stdout is JSON and nothing else.
 */
export function cliPainter(o: PainterOptions & { configFile?: string } = {}): Painter {
  const env = o.env ?? process.env;
  return makePainter({ ...o, env, theme: o.theme ?? themeChoice(env, o.configFile).name });
}

/** A question put to the user, in the theme's prompt style (plain when color is off). Used for every "[y/N]" prompt. */
export function askQuestion(rl: { question(query: string, cb: (answer: string) => void): void }, question: string, cb: (answer: string) => void): void {
  rl.question(promptText(question), cb);
}

export function promptText(question: string, p: Painter = cliPainter()): string {
  return p.level === 0 ? question : p.role("prompt", question);
}
