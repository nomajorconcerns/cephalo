/**
 * The Windows half of the command parser: PowerShell and cmd.exe. Same idea as shellparse.ts (split a command into the
 * pieces the rules should look at, never run anything, only add text to check), with the quoting rules of those shells:
 *   PowerShell: 'single' ('' inside), "double" (`" and "" inside, $(...) expands), @' here-strings '@, ` as the escape,
 *               <# block comments #>, { script blocks }, ( ), $( ), @( ), ;, |, &&, ||, the & call operator
 *   cmd.exe:    "double" quotes only, ^ as the escape, &, &&, ||, |, ( ), REM comments
 * It reads inline code in `powershell -Command`, `-EncodedCommand` (base64 of UTF-16), `Invoke-Expression`/`iex`,
 * and `cmd /c`, and expands the Remove-Item aliases and shortened parameter names (`ri -r -fo`) so a rule written
 * for `Remove-Item -Recurse -Force` still sees them.
 */
import { analyzeInto, baseName, decodeBase64Text, emit, newCtx, MAX_INPUT, stripWrappers, type Analysis, type Ctx } from "./shellparse.js";

type Dialect = "ps" | "cmd";

interface Word {
  raw: string;
  val: string;
  at: number;
}
interface Cmd {
  start: number;
  end: number;
  words: Word[];
}

/** Analyze a command as PowerShell or cmd.exe text. */
export function analyzeWindows(raw: string, dialect: Dialect, ctx: Ctx = newCtx()): Analysis {
  if (raw.length > MAX_INPUT) return { ok: false, units: [], single: false };
  winInto(raw, dialect, ctx);
  return { ok: ctx.ok, units: [...ctx.units], single: ctx.ok && !ctx.complex && ctx.simple === 1 };
}

const MAX_DEPTH = 6;

function winInto(script: string, dialect: Dialect, ctx: Ctx): void {
  if (ctx.budget.depth >= MAX_DEPTH || script.length > MAX_INPUT) {
    ctx.ok = false;
    emit(ctx, script);
    return;
  }
  ctx.budget.depth++;
  try {
    const p = new WinParser(script, dialect, ctx);
    p.processAll(p.scan(""));
  } catch {
    ctx.ok = false;
    emit(ctx, script);
  } finally {
    ctx.budget.depth--;
  }
}

const PS_ESC: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0", a: "\x07", b: "\b", f: "\f", v: "\v" };

class WinParser {
  i = 0;
  constructor(
    readonly s: string,
    readonly d: Dialect,
    readonly ctx: Ctx,
  ) {}

  private fail(): void {
    this.ctx.ok = false;
  }

  /** Read commands until the end, or until the bracket that closes a ( or { group. */
  scan(close: "" | ")" | "}"): Cmd[] {
    const s = this.s;
    const ps = this.d === "ps";
    const out: Cmd[] = [];
    let cmd: Cmd = { start: -1, end: 0, words: [] };
    let word: Word | null = null;
    let redir = false;
    const w = (): Word => (word ??= { raw: "", val: "", at: this.i });
    const endWord = () => {
      if (word) {
        if (redir) redir = false; // the target of > or <: not part of the command
        else {
          if (cmd.start < 0) cmd.start = (word as Word).at;
          cmd.words.push(word);
        }
        word = null;
      }
    };
    const flush = () => {
      endWord();
      if (cmd.words.length) {
        cmd.end = this.i;
        out.push(cmd);
      }
      cmd = { start: -1, end: 0, words: [] };
    };

    while (this.i < s.length) {
      const c = s[this.i]!;
      const n = s[this.i + 1];
      if (ps && c === "`") {
        if (n === "\n") {
          this.i += 2;
          continue;
        }
        if (n === "\r" && s[this.i + 2] === "\n") {
          this.i += 3;
          continue;
        }
        const ww = w();
        if (n !== undefined) {
          ww.raw += c + n;
          ww.val += PS_ESC[n] ?? n;
          this.i += 2;
        } else {
          ww.raw += c;
          this.i++;
        }
      } else if (!ps && c === "^") {
        const ww = w();
        if (n !== undefined && n !== "\n") {
          ww.raw += c + n;
          ww.val += n;
          this.i += 2;
        } else {
          this.i += n === "\n" ? 2 : 1;
        }
      } else if (c === "'" && ps) {
        this.psSingle(w());
      } else if (c === '"') {
        this.dquote(w());
      } else if (ps && c === "@" && (n === "'" || n === '"') && /^\r?\n/.test(s.slice(this.i + 2, this.i + 4))) {
        this.hereString(w());
      } else if (ps && c === "$" && n === "(") {
        this.group(w(), ")");
      } else if (ps && c === "@" && n === "(") {
        this.group(w(), ")");
      } else if (ps && c === "$" && n === "{") {
        const j = s.indexOf("}", this.i);
        const end = j < 0 ? s.length : j + 1;
        const ww = w();
        ww.raw += s.slice(this.i, end);
        ww.val += s.slice(this.i, end);
        this.i = end;
      } else if (c === "(") {
        this.group(w(), ")");
      } else if (ps && c === "{") {
        this.group(w(), "}");
      } else if (c === ")" || (ps && c === "}")) {
        if (c === close) {
          flush();
          this.i++;
          return out;
        }
        this.fail();
        this.i++;
      } else if (c === " " || c === "\t" || c === "\r") {
        endWord();
        this.i++;
      } else if (c === "\n") {
        flush();
        this.i++;
      } else if (ps && c === "#" && !word) {
        const j = s.indexOf("\n", this.i);
        this.i = j < 0 ? s.length : j;
      } else if (ps && c === "<" && n === "#") {
        const j = s.indexOf("#>", this.i + 2);
        if (j < 0) this.fail();
        this.i = j < 0 ? s.length : j + 2;
      } else if (c === ";" || c === "|" || c === "&") {
        flush();
        // && and || are one operator; a lone & is a command separator in cmd and the call operator (or background) in PowerShell
        this.i += n === c ? 2 : 1;
      } else if (c === ">" || c === "<") {
        if (word && /^[0-9]+$/.test((word as Word).raw)) word = null;
        else endWord();
        while (s[this.i] === ">" || s[this.i] === "<") this.i++;
        if (s[this.i] === "&") {
          // 2>&1: the target is a handle number
          this.i++;
          while (/[0-9-]/.test(s[this.i] ?? "")) this.i++;
        } else redir = true;
      } else {
        const ww = w();
        ww.raw += c;
        ww.val += c;
        this.i++;
      }
    }
    if (close) this.fail();
    flush();
    return out;
  }

  /** A ( ) / { } / $( ) group: its commands are read on their own, and its text stays part of the word. */
  private group(ww: Word, close: ")" | "}"): void {
    const start = this.i;
    this.ctx.complex = true;
    this.i += this.s[this.i] === "(" || this.s[this.i] === "{" ? 1 : this.s[this.i + 1] === "(" ? 2 : 1;
    const inner = this.scan(close);
    this.processAll(inner);
    ww.raw += this.s.slice(start, this.i);
    ww.val += this.s.slice(start, this.i);
  }

  private psSingle(ww: Word): void {
    const s = this.s;
    let j = this.i + 1;
    let val = "";
    for (;;) {
      if (j >= s.length) {
        this.fail();
        break;
      }
      if (s[j] === "'") {
        if (s[j + 1] === "'") {
          val += "'";
          j += 2;
          continue;
        }
        j++;
        break;
      }
      val += s[j];
      j++;
    }
    ww.raw += s.slice(this.i, j);
    ww.val += val;
    this.i = j;
  }

  private dquote(ww: Word): void {
    const s = this.s;
    const ps = this.d === "ps";
    const start = this.i;
    let j = this.i + 1;
    let val = "";
    for (;;) {
      if (j >= s.length) {
        this.fail();
        break;
      }
      const c = s[j]!;
      if (c === '"') {
        if (s[j + 1] === '"') {
          val += '"';
          j += 2;
          continue;
        }
        j++;
        break;
      }
      if (ps && c === "`" && j + 1 < s.length) {
        val += PS_ESC[s[j + 1]!] ?? s[j + 1];
        j += 2;
        continue;
      }
      if (ps && c === "$" && s[j + 1] === "(") {
        // a sub-expression inside the string runs: read it as commands
        this.ctx.complex = true;
        const sub = new WinParser(s, this.d, this.ctx);
        sub.i = j + 2;
        const inner = sub.scan(")");
        sub.processAll(inner);
        val += s.slice(j, sub.i);
        j = sub.i;
        continue;
      }
      val += c;
      j++;
    }
    ww.raw += s.slice(start, j);
    ww.val += val;
    this.i = j;
  }

  private hereString(ww: Word): void {
    const s = this.s;
    const q = s[this.i + 1]!;
    const bodyStart = s.indexOf("\n", this.i) + 1;
    const re = new RegExp(`(^|\\n)${q}@`);
    const m = re.exec(s.slice(bodyStart));
    if (!m) {
      this.fail();
      ww.raw += s.slice(this.i);
      ww.val += s.slice(bodyStart);
      this.i = s.length;
      return;
    }
    const start = this.i;
    ww.val += s.slice(bodyStart, bodyStart + m.index).replace(/\r$/, "");
    this.i = bodyStart + m.index + m[0].length;
    ww.raw += s.slice(start, this.i);
  }

  /* ---------------------------------------------------------------- meaning */

  processAll(cmds: Cmd[]): void {
    for (const c of cmds) this.process(c);
  }

  private process(cmd: Cmd): void {
    const ctx = this.ctx;
    const ps = this.d === "ps";
    let words = cmd.words;
    // PowerShell's call operator and dot-sourcing, cmd's @ echo suppression
    while (words.length && /^(&|\.|@)$/.test(words[0]!.raw)) words = words.slice(1);
    if (words.length && !ps) {
      const first = words[0]!.val.replace(/^@/, "");
      if (/^rem$/i.test(first)) return;
      if (first !== words[0]!.val) words = [{ raw: first, val: first, at: words[0]!.at }, ...words.slice(1)];
    }
    if (!words.length) return;
    const source = this.s.slice(Math.max(cmd.start, 0), cmd.end).trim();
    ctx.simple++;
    let vals = words.map((x) => x.val);
    emit(ctx, source);
    const joined = vals.join(" ");
    if (joined !== source) emit(ctx, joined);

    if (!ps) {
      // `if exist X del ...`, `if not defined X ...`, `for %i in (...) do cmd`: the command is what follows
      const text = joined;
      const m = /^if\s+(?:\/i\s+)?(?:not\s+)?(?:exist\s+\S+|defined\s+\S+|errorlevel\s+\d+)\s+(.+)$/i.exec(text) ?? /\bdo\s+(.+)$/i.exec(text);
      if (m) {
        ctx.complex = true;
        winInto(m[1]!, "cmd", ctx);
        return;
      }
    }

    const wrapped = stripWrappers(vals);
    if (wrapped && wrapped.length) {
      ctx.complex = true;
      vals = wrapped;
      emit(ctx, vals.join(" "));
    }
    const name = baseName(vals[0]!);
    const args = vals.slice(1);

    // Remove-Item and its aliases, with shortened parameter names spelled out
    if (["remove-item", "ri", "rm", "rmdir", "rd", "del", "erase"].includes(name) && args.some((a) => /^-[A-Za-z]/.test(a))) {
      const expanded = expandRemoveItem(args);
      if (expanded.join(" ") !== args.join(" ")) {
        ctx.complex = true;
        emit(ctx, `Remove-Item ${expanded.join(" ")}`);
      }
    }
    if (name === "invoke-expression" || name === "iex") {
      ctx.complex = true;
      const code = args.filter((a) => !/^-(command)$/i.test(a)).join(" ");
      winInto(code, "ps", ctx);
      analyzeInto(code, ctx);
      return;
    }
    if (name === "powershell" || name === "pwsh" || name === "powershell_ise") {
      for (let k = 0; k < args.length; k++) {
        const a = args[k]!;
        if (/^-(c|co|com|comm|comma|comman|command)$/i.test(a)) {
          ctx.complex = true;
          const code = args.slice(k + 1).join(" ");
          winInto(code, "ps", ctx);
          analyzeInto(code, ctx);
          break;
        }
        if (/^-(e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)$/i.test(a) && args[k + 1]) {
          ctx.complex = true;
          const text = decodeUtf16Base64(args[k + 1]!);
          if (text) {
            winInto(text, "ps", ctx);
            analyzeInto(text, ctx);
          } else this.fail();
          break;
        }
      }
      return;
    }
    if (name === "cmd") {
      for (let k = 0; k < args.length; k++) {
        if (/^\/[ckr]$/i.test(args[k]!) || /^\/[ckr]/i.test(args[k]!)) {
          ctx.complex = true;
          const first = args[k]!.length > 2 ? args[k]!.slice(2) : "";
          const rest = [first, ...args.slice(k + 1)].filter(Boolean).join(" ");
          winInto(rest, "cmd", ctx);
          analyzeInto(rest, ctx);
          break;
        }
      }
    }
    if (name === "start-process" || name === "saps" || name === "start") {
      // Start-Process cmd -ArgumentList "/c ..." : the argument text is code for the program it starts
      const k = args.findIndex((a) => /^-ArgumentList$/i.test(a));
      if (k >= 0 && args[k + 1]) {
        ctx.complex = true;
        emit(ctx, `${args.find((a) => !a.startsWith("-")) ?? ""} ${args[k + 1]}`);
        winInto(args[k + 1]!, "cmd", ctx);
      }
    }
  }
}

/** Remove-Item parameter names, to resolve a unique shortened form (-r -> -Recurse, -fo -> -Force). */
const REMOVE_ITEM_PARAMS = ["Path", "LiteralPath", "Filter", "Include", "Exclude", "Recurse", "Force", "Credential", "Stream", "WhatIf", "Confirm"];
function expandRemoveItem(args: string[]): string[] {
  return args.map((a) => {
    const m = /^-([A-Za-z]+)(:.*)?$/.exec(a);
    if (!m) return a;
    const hits = REMOVE_ITEM_PARAMS.filter((p) => p.toLowerCase().startsWith(m[1]!.toLowerCase()));
    return hits.length === 1 ? `-${hits[0]}${m[2] ?? ""}` : a;
  });
}

/** The text of a PowerShell -EncodedCommand value (base64 of UTF-16LE). */
function decodeUtf16Base64(b64: string): string | undefined {
  try {
    const t = Buffer.from(b64, "base64").toString("utf16le");
    return /^[\x09\x0a\x0d\x20-\x7e]{2,}$/.test(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

// keep the shared helper imported for callers that decode plain base64 text found in PowerShell strings
void decodeBase64Text;
