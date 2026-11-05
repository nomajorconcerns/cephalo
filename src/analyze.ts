import { analyzeShell, MAX_INPUT, type Analysis } from "./shellparse.js";
import { analyzeWindows } from "./winparse.js";

export type { Analysis } from "./shellparse.js";

/** Does this command look like PowerShell or cmd.exe? (a cmdlet name, $env:, %VAR%, a drive path, powershell/cmd, cmd flags, a PowerShell alias) */
export function looksWindows(raw: string): boolean {
  return (
    /\b(powershell|pwsh)(\.exe)?\b/i.test(raw) ||
    /\bcmd(\.exe)?\s+\/[a-z]/i.test(raw) ||
    /\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/.test(raw) ||
    /\$env:|%[A-Za-z_][A-Za-z0-9_]*%|(^|[\s"'])[A-Za-z]:[\\/]/.test(raw) ||
    /\s\/[sqfpy](\s|$)/i.test(raw) ||
    /\b(iex|iwr|irm|ri|rd|del|erase|saps)\b/i.test(raw) ||
    /`[A-Za-z]|\^[A-Za-z]/.test(raw) ||
    /(^|[;&|]\s*)(rem|set|if exist|for %)\b/i.test(raw)
  );
}

/**
 * Read a command as bash/sh/zsh AND (when it looks like Windows shell) as PowerShell and cmd.exe, and return the pieces the rules should check on their
 * own. The shells disagree about quoting, so each reading adds what it finds; none of them removes anything.
 *
 *   ok      the main reading (POSIX shell) understood the whole command. When false, the caller uses plain text
 *           matching and gives no exemptions (`action: allow` rules are ignored for text the parser could not read).
 *   units   extra texts to check
 *   single  one plain command: its raw text is the only thing there is to check
 */
export function analyzeCommand(raw: string): Analysis {
  if (raw.length > MAX_INPUT) return { ok: false, units: [], single: false };
  const units = new Set<string>();
  let ok = false;
  let single = false;
  try {
    const sh = analyzeShell(raw);
    ok = sh.ok;
    single = sh.single;
    for (const u of sh.units) units.add(u);
  } catch {
    /* fall through: text matching only */
  }
  // PowerShell and cmd.exe split text differently (cmd has no single quotes, for one). Reading a bash command that way
  // would make pieces that were never commands, so these readings run only on text that looks like Windows shell.
  for (const dialect of looksWindows(raw) ? (["ps", "cmd"] as const) : []) {
    try {
      const w = analyzeWindows(raw, dialect);
      for (const u of w.units) units.add(u);
      // a Windows reading that found more than one command, or unwrapped something, means the command is not "single"
      if (!w.single && w.units.length > 1) single = false;
    } catch {
      single = false;
    }
  }
  const list = [...units];
  // a single plain command has one unit (its own text) or two (the same text with its quoting resolved)
  if (single && list.length > 2) single = false;
  return { ok, units: list, single: ok && single };
}
