// src/banner.ts
// Cephalo terminal logo: a pixel octopus drawn with half-block characters,
// next to a gradient "CEPHALO" wordmark. The colors come from the active theme
// (see theme.ts); this file has none of its own.
//
// Never call printBanner() from `cephalo hook ...` commands: hook stdout
// must contain only JSON, or Claude Code and Hermes can't read the decision.

import { cliPainter } from "./term.js";
import { colorLevel, mix, shade, type Painter, type RGB } from "./theme.js";

// Pixel octopus: 16 x 12 pixels. Two pixel rows become one terminal row.
// "." = transparent. The letters are theme colors: P body, L shine, W eye white, K pupil.
export const OCTOPUS = [
  "......PPPP......",
  "...PPPPPPPPPP...",
  "..PPLLPPPPPPPP..",
  ".PPLPPPPPPPPPPP.",
  ".PPPWWPPPPWWPPP.",
  ".PPPWKPPPPWKPPP.",
  ".PPPPPPPPPPPPPP.",
  "..PPPPPPPPPPPP..",
  ".PP.PP.PP.PP.PP.",
  "PP..P..PP..P..PP",
  "P..PP..PP..PP..P",
  ".PP..PP..PP..PP.",
];

/** Poses for the animation. Tentacles are the bottom four pixel rows; the eyes are rows 4 and 5. Every pose is 16 pixels wide. */
export const TENTACLES: string[][] = [
  OCTOPUS.slice(8),
  [".PP.PP.PP.PP.PP.", ".PP..P.PP.P..PP.", "PP..PP.PP.PP..PP", ".P..PP.PP.PP..P."],
  [".PP.PP.PP.PP.PP.", "PP.P..PP..P..PP.", "P..PP.PP.PP.P..P", "..PP..PP..PP..P."],
];
const EYES_CLOSED = [".PPPPPPPPPPPPPP.", ".PPPKKPPPPKKPPP."];

export interface Pose {
  /** Which tentacle shape (0 is the resting one). */
  tentacles?: number;
  blink?: boolean;
}

/** The octopus drawing in a pose: OCTOPUS for the default. */
export function poseRows(pose: Pose = {}): string[] {
  const rows = OCTOPUS.slice();
  if (pose.blink) rows.splice(4, 2, ...EYES_CLOSED);
  const t = TENTACLES[(pose.tentacles ?? 0) % TENTACLES.length]!;
  rows.splice(8, 4, ...t);
  return rows;
}

// "cephalo" in the ANSI Shadow figlet font.
const WORDMARK = [
  " ██████╗███████╗██████╗ ██╗  ██╗ █████╗ ██╗      ██████╗ ",
  "██╔════╝██╔════╝██╔══██╗██║  ██║██╔══██╗██║     ██╔═══██╗",
  "██║     █████╗  ██████╔╝███████║███████║██║     ██║   ██║",
  "██║     ██╔══╝  ██╔═══╝ ██╔══██║██╔══██║██║     ██║   ██║",
  "╚██████╗███████╗██║     ██║  ██║██║  ██║███████╗╚██████╔╝",
  " ╚═════╝╚══════╝╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝ ╚═════╝ ",
];

const TAGLINE = "the seatbelt for AI coding agents";

/** The octopus colors by letter, for one frame of a drawing. */
export function octopusColors(p: Painter): Record<string, RGB> {
  const o = p.palette.octopus;
  return { P: o.body, L: o.shine, W: o.eye, K: o.pupil };
}

/** Turns pixel rows into terminal rows of half-block characters. `rows` is OCTOPUS, or another frame of the same size. */
export function octopusRows(p: Painter, rows: string[] = OCTOPUS): string[] {
  const colors = octopusColors(p);
  const out: string[] = [];
  for (let y = 0; y < rows.length; y += 2) {
    let line = "";
    for (let x = 0; x < rows[y]!.length; x++) {
      const top = colors[rows[y]![x]!];
      const bottom = colors[rows[y + 1]?.[x] ?? "."];
      if (!top && !bottom) line += " ";
      else if (top && !bottom) line += p.rgb(top, undefined, "▀");
      else if (!top && bottom) line += p.rgb(bottom, undefined, "▄");
      else if (top === bottom) line += p.rgb(top, undefined, "█");
      else line += p.rgb(top, bottom, "▀");
    }
    out.push(line);
  }
  return out;
}

// Colors the wordmark with the theme's gradient. The solid blocks get
// the full color and the box-drawing "shadow" characters a darker shade.
function wordmarkRows(p: Painter): string[] {
  const { from, to } = p.palette;
  const width = Math.max(...WORDMARK.map((l) => [...l].length));
  return WORDMARK.map((line) =>
    [...line]
      .map((ch, i) => {
        if (ch === " ") return " ";
        const color = mix(from, to, i / (width - 1));
        return p.rgb(ch === "█" ? color : p.mode === "light" ? mix(color, [255, 255, 255], 0.45) : shade(color, 0.45), undefined, ch);
      })
      .join(""),
  );
}

function gradientText(p: Painter, text: string): string {
  const chars = [...text];
  const { from, to } = p.palette;
  return chars.map((ch, i) => p.rgb(mix(from, to, i / Math.max(chars.length - 1, 1)), undefined, ch)).join("");
}

/** True when this terminal gets color (kept for callers that only need yes/no). */
export function supportsColor(): boolean {
  return colorLevel() > 0;
}

export interface BannerOptions {
  /** Terminal width to lay out for. */
  columns?: number;
}

export function banner(version: string, p: Painter = cliPainter(), o: BannerOptions = {}): string {
  if (p.level === 0) {
    return `cephalo v${version} - ${TAGLINE}\n`;
  }

  const octo = octopusRows(p);
  const gap = "   ";
  const columns = o.columns ?? process.stdout.columns ?? 80;
  const dim = (s: string) => p.role("dim", s);

  // Narrow terminal: octopus with a compact text label beside it.
  if (columns < 78) {
    const label = ["", "", gradientText(p, "cephalo") + dim(`  v${version}`), dim(TAGLINE), "", ""];
    return "\n" + octo.map((row, i) => row + gap + label[i]).join("\n") + "\n\n";
  }

  // Full logo: octopus + wordmark, tagline underneath the wordmark.
  const word = wordmarkRows(p);
  const indent = " ".repeat(16) + gap;
  const lines = octo.map((row, i) => row + gap + word[i]);
  lines.push(indent + dim(TAGLINE + "  ·  v" + version));
  return "\n" + lines.join("\n") + "\n\n";
}

export function printBanner(version: string, p: Painter = cliPainter()): void {
  process.stdout.write(banner(version, p));
}
