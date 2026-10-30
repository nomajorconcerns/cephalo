// src/banner.ts
// Cephalo terminal logo: a pixel octopus drawn with half-block characters,
// next to a gradient "CEPHALO" wordmark. Uses 24-bit ANSI color.
//
// Never call printBanner() from `cephalo hook ...` commands: hook stdout
// must contain only JSON, or Claude Code and Hermes can't read the decision.

type RGB = [number, number, number];

// Pixel octopus: 16 x 12 pixels. Two pixel rows become one terminal row.
// "." = transparent. Letters map to the palette below.
const PALETTE: Record<string, RGB> = {
  P: [255, 92, 138], // body (coral pink)
  L: [255, 170, 200], // shine
  W: [255, 255, 255], // eye white
  K: [26, 26, 46], // pupil
};

const OCTOPUS = [
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

const TEAL: RGB = [45, 212, 191];
const VIOLET: RGB = [139, 92, 246];
const GRAY: RGB = [139, 148, 158];

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const fg = ([r, g, b]: RGB): string => `${ESC}38;2;${r};${g};${b}m`;
const bg = ([r, g, b]: RGB): string => `${ESC}48;2;${r};${g};${b}m`;

function mix(a: RGB, b: RGB, t: number): RGB {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as RGB;
}

function shade(c: RGB, factor: number): RGB {
  return c.map((v) => Math.round(v * factor)) as RGB;
}

// Converts the pixel octopus into 6 terminal rows of half-block characters.
function octopusRows(): string[] {
  const rows: string[] = [];
  for (let y = 0; y < OCTOPUS.length; y += 2) {
    let line = "";
    for (let x = 0; x < OCTOPUS[y].length; x++) {
      const top = PALETTE[OCTOPUS[y][x]];
      const bottom = PALETTE[OCTOPUS[y + 1]?.[x] ?? "."];
      if (!top && !bottom) line += " ";
      else if (top && !bottom) line += fg(top) + "▀" + RESET;
      else if (!top && bottom) line += fg(bottom) + "▄" + RESET;
      else if (top === bottom) line += fg(top!) + "█" + RESET;
      else line += fg(top!) + bg(bottom!) + "▀" + RESET;
    }
    rows.push(line);
  }
  return rows;
}

// Colors the wordmark with a teal-to-violet gradient. The solid blocks get
// the full color and the box-drawing "shadow" characters a darker shade.
function wordmarkRows(): string[] {
  const width = Math.max(...WORDMARK.map((l) => [...l].length));
  return WORDMARK.map(
    (line) =>
      [...line]
        .map((ch, i) => {
          if (ch === " ") return " ";
          const color = mix(TEAL, VIOLET, i / (width - 1));
          return fg(ch === "█" ? color : shade(color, 0.45)) + ch;
        })
        .join("") + RESET,
  );
}

function gradientText(text: string): string {
  const chars = [...text];
  return (
    chars
      .map((ch, i) => fg(mix(TEAL, VIOLET, i / Math.max(chars.length - 1, 1))) + ch)
      .join("") + RESET
  );
}

function supportsColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY) && process.env.TERM !== "dumb";
}

export function banner(version: string): string {
  if (!supportsColor()) {
    return `cephalo v${version} - ${TAGLINE}\n`;
  }

  const octo = octopusRows();
  const gap = "   ";
  const columns = process.stdout.columns ?? 80;

  // Narrow terminal: octopus with a compact text label beside it.
  if (columns < 78) {
    const label = [
      "",
      "",
      BOLD + gradientText("cephalo") + RESET + fg(GRAY) + `  v${version}` + RESET,
      fg(GRAY) + TAGLINE + RESET,
      "",
      "",
    ];
    return "\n" + octo.map((row, i) => row + gap + label[i]).join("\n") + "\n\n";
  }

  // Full logo: octopus + wordmark, tagline underneath the wordmark.
  const word = wordmarkRows();
  const indent = " ".repeat(16) + gap;
  const lines = octo.map((row, i) => row + gap + word[i]);
  lines.push(indent + fg(GRAY) + TAGLINE + "  ·  v" + version + RESET);
  return "\n" + lines.join("\n") + "\n\n";
}

export function printBanner(version: string): void {
  process.stdout.write(banner(version));
}
