/**
 * Every color the CLI prints comes from here. A theme says what each part of the output looks like (the logo, the
 * wordmark gradient, the ALLOW / BLOCK / ASK labels, doctor results, prompts); everything else asks a Painter for it.
 * Nothing outside this file writes an escape sequence, and `cephalo hook ...` never asks for color at all.
 *
 * Meaning never depends on color alone: ALLOW, BLOCK and ASK are always words, BLOCK is always bold, and the `ink`
 * theme (no color) tells them apart by bold, reverse video and underline.
 *
 * Each theme has a palette for dark terminals and one for light terminals. Colors are written as 24-bit RGB and
 * reduced to the 256-color or 16-color palette when the terminal cannot show more; with no color at all (NO_COLOR, a
 * pipe, TERM=dumb) the output has no escape sequences.
 */

export type RGB = [number, number, number];
export type Level = 0 | 1 | 2 | 3; // none | 16 colors | 256 colors | 24-bit
export type Mode = "dark" | "light";
export type Role = "allow" | "block" | "ask" | "shadow" | "ok" | "warn" | "fail" | "info" | "accent" | "dim" | "heading" | "prompt";

export interface Style {
  c?: RGB;
  bold?: boolean;
  dim?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface Octopus {
  body: RGB;
  shine: RGB;
  eye: RGB;
  pupil: RGB;
}

export interface Palette {
  /** The wordmark's gradient runs from `from` to `to`. */
  from: RGB;
  to: RGB;
  octopus: Octopus;
  roles: Record<Role, Style>;
}

export interface Theme {
  name: string;
  description: string;
  dark: Palette;
  light: Palette;
}

/** Roles from the handful of colors a theme chooses. `ok`, `warn` and `fail` follow allow, ask and block. */
function roles(c: { allow: RGB; block: RGB; ask: RGB; info: RGB; accent: RGB; dim: RGB; heading: RGB }): Record<Role, Style> {
  return {
    allow: { c: c.allow },
    block: { c: c.block, bold: true },
    ask: { c: c.ask, bold: true },
    shadow: { c: c.accent },
    ok: { c: c.allow },
    warn: { c: c.ask },
    fail: { c: c.block, bold: true },
    info: { c: c.info },
    accent: { c: c.accent },
    dim: { c: c.dim },
    heading: { c: c.heading, bold: true },
    prompt: { c: c.accent, bold: true },
  };
}

/** The no-color theme: everything is told apart by weight and underline, never hue. */
const INK_ROLES: Record<Role, Style> = {
  allow: {},
  block: { bold: true, inverse: true },
  ask: { bold: true, underline: true },
  shadow: { underline: true },
  ok: {},
  warn: { bold: true },
  fail: { bold: true, inverse: true },
  info: {},
  accent: { bold: true },
  dim: { dim: true },
  heading: { bold: true },
  prompt: { bold: true },
};

export const THEMES: Theme[] = [
  {
    name: "reef",
    description: "Teal to violet, with the pink octopus. The default.",
    dark: {
      from: [45, 212, 191],
      to: [139, 92, 246],
      octopus: { body: [255, 92, 138], shine: [255, 170, 200], eye: [255, 255, 255], pupil: [26, 26, 46] },
      roles: roles({ allow: [74, 222, 128], block: [255, 107, 107], ask: [245, 196, 107], info: [125, 211, 252], accent: [45, 212, 191], dim: [139, 148, 158], heading: [230, 237, 247] }),
    },
    light: {
      from: [13, 148, 136],
      to: [109, 40, 217],
      octopus: { body: [236, 72, 120], shine: [253, 164, 190], eye: [255, 255, 255], pupil: [26, 26, 46] },
      roles: roles({ allow: [21, 128, 61], block: [185, 28, 28], ask: [146, 78, 6], info: [3, 105, 161], accent: [15, 118, 110], dim: [87, 96, 106], heading: [17, 24, 39] }),
    },
  },
  {
    name: "abyss",
    description: "Deep navy and slate blue.",
    dark: {
      from: [147, 197, 253],
      to: [99, 120, 190],
      octopus: { body: [91, 125, 177], shine: [157, 184, 224], eye: [230, 237, 247], pupil: [11, 18, 32] },
      roles: roles({ allow: [110, 231, 183], block: [252, 129, 129], ask: [252, 211, 77], info: [148, 163, 184], accent: [125, 160, 255], dim: [122, 138, 160], heading: [226, 232, 240] }),
    },
    light: {
      from: [30, 64, 175],
      to: [71, 85, 105],
      octopus: { body: [51, 85, 140], shine: [120, 150, 200], eye: [241, 245, 249], pupil: [11, 18, 32] },
      roles: roles({ allow: [4, 120, 87], block: [190, 18, 60], ask: [133, 77, 14], info: [51, 65, 85], accent: [30, 64, 175], dim: [71, 85, 105], heading: [15, 23, 42] }),
    },
  },
  {
    name: "coral",
    description: "Warm pink, orange and cream.",
    dark: {
      from: [251, 113, 133],
      to: [253, 186, 116],
      octopus: { body: [255, 127, 102], shine: [255, 213, 190], eye: [255, 247, 237], pupil: [92, 38, 18] },
      roles: roles({ allow: [134, 239, 172], block: [251, 113, 133], ask: [252, 211, 77], info: [253, 186, 116], accent: [253, 186, 116], dim: [190, 168, 156], heading: [255, 237, 213] }),
    },
    light: {
      from: [190, 18, 60],
      to: [194, 65, 12],
      octopus: { body: [234, 88, 62], shine: [253, 186, 160], eye: [255, 247, 237], pupil: [92, 38, 18] },
      roles: roles({ allow: [22, 101, 52], block: [159, 18, 57], ask: [133, 77, 14], info: [154, 52, 18], accent: [194, 65, 12], dim: [120, 90, 80], heading: [67, 20, 7] }),
    },
  },
  {
    name: "glow",
    description: "Bioluminescent cyan and green on black.",
    dark: {
      from: [34, 211, 238],
      to: [74, 222, 128],
      octopus: { body: [34, 211, 238], shine: [165, 243, 252], eye: [236, 254, 255], pupil: [2, 44, 34] },
      roles: roles({ allow: [74, 222, 128], block: [248, 113, 113], ask: [250, 204, 21], info: [103, 232, 249], accent: [34, 211, 238], dim: [110, 160, 160], heading: [207, 250, 254] }),
    },
    light: {
      from: [14, 116, 144],
      to: [21, 128, 61],
      octopus: { body: [8, 145, 178], shine: [103, 200, 220], eye: [236, 254, 255], pupil: [2, 44, 34] },
      roles: roles({ allow: [21, 128, 61], block: [185, 28, 28], ask: [133, 77, 14], info: [14, 116, 144], accent: [14, 116, 144], dim: [55, 95, 95], heading: [8, 51, 68] }),
    },
  },
  {
    name: "ink",
    description: "Monochrome. Weight, underline and reverse video carry the meaning.",
    dark: {
      from: [243, 244, 246],
      to: [156, 163, 175],
      octopus: { body: [209, 213, 219], shine: [249, 250, 251], eye: [255, 255, 255], pupil: [17, 24, 39] },
      roles: INK_ROLES,
    },
    light: {
      from: [17, 24, 39],
      to: [107, 114, 128],
      octopus: { body: [75, 85, 99], shine: [156, 163, 175], eye: [255, 255, 255], pupil: [17, 24, 39] },
      roles: INK_ROLES,
    },
  },
];

export const DEFAULT_THEME = "reef";

export const themeNames = (): string[] => THEMES.map((t) => t.name);
export const isThemeName = (n: unknown): n is string => typeof n === "string" && THEMES.some((t) => t.name === n);
export function getTheme(name: string | undefined): Theme {
  return THEMES.find((t) => t.name === name) ?? THEMES.find((t) => t.name === DEFAULT_THEME)!;
}

/* ------------------------------------------------------------------ what the terminal can show */

export interface Env {
  [k: string]: string | undefined;
}

/**
 * How many colors to use. NO_COLOR wins; FORCE_COLOR turns color on for pipes (0/false off, 1 = 16 colors, 2 = 256, 3 = 24-bit);
 * otherwise only an interactive terminal that is not TERM=dumb gets color, at the depth it advertises.
 */
export function colorLevel(env: Env = process.env, isTTY: boolean = Boolean(process.stdout.isTTY), platform: string = process.platform): Level {
  if (env.NO_COLOR) return 0;
  const force = env.FORCE_COLOR;
  if (force !== undefined && force.trim() !== "") {
    const f = force.trim().toLowerCase();
    if (f === "0" || f === "false") return 0;
    if (f === "2") return 2;
    if (f === "3") return 3;
    return depthFromEnv(env, platform, 1);
  }
  if (!isTTY || env.TERM === "dumb") return 0;
  return depthFromEnv(env, platform, 1);
}

/** The deepest color the terminal says it supports (`floor` when it says nothing). */
function depthFromEnv(env: Env, platform: string, floor: Level): Level {
  const ct = (env.COLORTERM ?? "").toLowerCase();
  if (ct === "truecolor" || ct === "24bit") return 3;
  if (env.WT_SESSION || env.TERM_PROGRAM === "iTerm.app" || env.TERM_PROGRAM === "vscode" || env.KITTY_WINDOW_ID || env.WEZTERM_EXECUTABLE) return 3;
  if (/256color/i.test(env.TERM ?? "") || env.TERM_PROGRAM === "Apple_Terminal") return 2;
  if (platform === "win32" && floor === 1) return 3; // Windows 10+ consoles take 24-bit color
  return floor;
}

/** Dark or light terminal background: CEPHALO_BACKGROUND, then COLORFGBG ("15;0": the last field is the background), else dark. */
export function backgroundMode(env: Env = process.env): Mode {
  const b = (env.CEPHALO_BACKGROUND ?? "").toLowerCase();
  if (b === "light" || b === "dark") return b;
  const parts = (env.COLORFGBG ?? "").split(";");
  const bg = Number(parts[parts.length - 1]);
  if (parts.length >= 2 && Number.isInteger(bg)) return bg === 7 || bg === 15 ? "light" : "dark";
  return "dark";
}

/* ------------------------------------------------------------------ color maths */

/**
 * The 16-color palette is whatever the user's terminal theme says, so distances in RGB mean little. Pick by hue instead:
 * red, yellow, green, cyan, blue or magenta, bright on dark terminals and the plain one on light terminals, and grays
 * by lightness. Never black on dark or white on light, which would vanish.
 */
export function toAnsi16(c: RGB, mode: Mode = "dark"): number {
  const [r, g, b] = c.map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (sat < 0.18) {
    if (l < 0.2) return mode === "dark" ? 8 : 0;
    if (l < 0.65) return 8;
    return mode === "dark" ? (l < 0.85 ? 7 : 15) : 8;
  }
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const base = h < 20 || h >= 335 ? 1 : h < 75 ? 3 : h < 165 ? 2 : h < 200 ? 6 : h < 265 ? 4 : 5;
  return mode === "dark" ? base + 8 : base;
}

const dist = (a: RGB, b: RGB) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** Nearest entry in the 256-color palette (6x6x6 cube or the gray ramp). */
export function toAnsi256(c: RGB): number {
  const lvl = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
  const steps = [0, 95, 135, 175, 215, 255];
  const [r, g, b] = [lvl(c[0]), lvl(c[1]), lvl(c[2])];
  const cube: RGB = [steps[r]!, steps[g]!, steps[b]!];
  const grayIdx = Math.max(0, Math.min(23, Math.round((((c[0] + c[1] + c[2]) / 3) - 8) / 10)));
  const gv = 8 + grayIdx * 10;
  const gray: RGB = [gv, gv, gv];
  return dist(c, gray) < dist(c, cube) ? 232 + grayIdx : 16 + 36 * r + 6 * g + b;
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as RGB;
}
export const shade = (c: RGB, f: number): RGB => c.map((v) => Math.round(v * f)) as RGB;

/** WCAG relative luminance and contrast ratio, for the themes' own tests. */
export function luminance([r, g, b]: RGB): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/* ------------------------------------------------------------------ the painter */

export interface Painter {
  level: Level;
  mode: Mode;
  theme: Theme;
  palette: Palette;
  /** Text in the style of a role (identity at level 0). */
  role(r: Role, text: string): string;
  /** Text in an explicit style. */
  style(s: Style, text: string): string;
  /** Text in explicit foreground and/or background colors (the logo's half-blocks). */
  rgb(fg: RGB | undefined, bg: RGB | undefined, text: string): string;
  /** ALLOW / BLOCK / ASK in its role's style. The word is always there. */
  label(kind: "allow" | "block" | "ask", text?: string): string;
}

export interface PainterOptions {
  env?: Env;
  isTTY?: boolean;
  platform?: string;
  /** Theme name; unknown or missing falls back to the default. */
  theme?: string;
  /** Overrides detection (tests, or a command that must never color). */
  level?: Level;
  mode?: Mode;
}

const ESC = "\u001b[";

export function makePainter(o: PainterOptions = {}): Painter {
  const env = o.env ?? process.env;
  const level = o.level ?? colorLevel(env, o.isTTY, o.platform);
  const mode = o.mode ?? backgroundMode(env);
  const theme = getTheme(o.theme);
  const palette = mode === "light" ? theme.light : theme.dark;

  const fgCode = (c: RGB): string => (level === 3 ? `38;2;${c[0]};${c[1]};${c[2]}` : level === 2 ? `38;5;${toAnsi256(c)}` : (() => { const i = toAnsi16(c, mode); return String(i < 8 ? 30 + i : 90 + (i - 8)); })());
  const bgCode = (c: RGB): string => (level === 3 ? `48;2;${c[0]};${c[1]};${c[2]}` : level === 2 ? `48;5;${toAnsi256(c)}` : (() => { const i = toAnsi16(c, mode); return String(i < 8 ? 40 + i : 100 + (i - 8)); })());
  const wrap = (codes: string[], text: string) => (codes.length ? `${ESC}${codes.join(";")}m${text}${ESC}0m` : text);

  const style = (s: Style, text: string): string => {
    if (level === 0 || text === "") return text;
    const codes: string[] = [];
    if (s.bold) codes.push("1");
    if (s.dim) codes.push("2");
    if (s.underline) codes.push("4");
    if (s.inverse) codes.push("7");
    if (s.c) codes.push(fgCode(s.c));
    return wrap(codes, text);
  };
  const rgb = (fg: RGB | undefined, bg: RGB | undefined, text: string): string => {
    if (level === 0 || text === "") return text;
    const codes: string[] = [];
    if (fg) codes.push(fgCode(fg));
    if (bg) codes.push(bgCode(bg));
    return wrap(codes, text);
  };
  const role = (r: Role, text: string) => style(palette.roles[r], text);
  const label = (kind: "allow" | "block" | "ask", text?: string) => role(kind, text ?? kind.toUpperCase());
  return { level, mode, theme, palette, role, style, rgb, label };
}
