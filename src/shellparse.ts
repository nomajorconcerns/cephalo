/**
 * A small shell parser for the command rules. It does not run or expand anything. It reads a command the way bash/sh/zsh
 * would split it (quotes, escapes, pipes, &&, ||, ;, subshells, $(...), backticks, <(...), heredocs) and returns the
 * pieces ("units") so each command can be checked on its own: every simple command, the same command with its quoting
 * resolved and its wrappers (sudo, env, timeout...) stripped, the code inside `bash -c`, `python -c`, `node -e`,
 * `eval`, `ssh host "..."`, `find -exec ...`, and the commands inside substitutions.
 *
 * It only ever ADDS text for the rules to look at. The caller keeps checking the raw command too, and when this parser
 * cannot read a command it says so (`ok: false`) and the caller falls back to plain text matching.
 */

export interface Analysis {
  /** The whole command was read cleanly. False: an unbalanced quote or bracket, an unterminated heredoc, a construct it does not handle, or a limit was hit. */
  ok: boolean;
  /** Texts to check besides the raw command, in the order found. */
  units: string[];
  /** Exactly one plain command: no substitutions, subshells, wrappers, unwrapped code or heredocs. */
  single: boolean;
}

export const MAX_INPUT = 100_000;
const MAX_DEPTH = 6;
const MAX_UNITS = 400;

export interface Ctx {
  units: Set<string>;
  ok: boolean;
  complex: boolean;
  simple: number;
  vars: Map<string, string>;
  budget: { depth: number };
}

export function newCtx(): Ctx {
  return { units: new Set(), ok: true, complex: false, simple: 0, vars: new Map(), budget: { depth: 0 } };
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "csh", "tcsh", "rbash"]);
const RESERVED = new Set(["if", "then", "else", "elif", "fi", "while", "until", "do", "done", "for", "select", "in", "case", "esac", "!", "{", "}", "function", "coproc"]);

/** The name of a program: no directory, no .exe, lower case. */
export function baseName(w: string): string {
  return w.replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat|com)$/i, "").toLowerCase();
}

/** Resolve \xNN, \uNNNN, \NNN (octal) and the usual single-letter escapes, as ANSI-C quoting and most languages' string literals do. */
export function decodeEscapes(s: string): string {
  return s.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{1,3}|[abefnrtv\\'"?`$ ])/g, (_m, e: string) => {
    const c = e[0]!;
    if (c === "x") return String.fromCharCode(parseInt(e.slice(1), 16));
    if (c === "u" || c === "U") {
      const cp = parseInt(e.slice(1), 16);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    }
    if (/[0-7]/.test(c)) return String.fromCharCode(parseInt(e, 8));
    const map: Record<string, string> = { a: "\x07", b: "\b", e: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
    return map[c] ?? c;
  });
}

interface Word {
  raw: string;
  val: string;
  quoted: boolean;
  /** Where the word starts in the text. */
  at: number;
}
interface Redir {
  op: string;
  fd?: string;
  target?: Word;
}
interface Cmd {
  start: number;
  end: number;
  words: Word[];
  redirs: Redir[];
  heredocs: Array<{ body: string; quoted: boolean }>;
  /** The operator that ended this command: "|", "&&", ";", "\n", ... */
  sep: string;
}
/** `start` stays -1 until the first word of the command is read, so the command's text does not begin with the operator before it. */
const newCmd = (): Cmd => ({ start: -1, end: 0, words: [], redirs: [], heredocs: [], sep: "" });

interface PendingHeredoc {
  cmd: Cmd;
  delim: string;
  strip: boolean;
  quoted: boolean;
}

export function emit(ctx: Ctx, text: string): void {
  const t = text.trim();
  if (!t) return;
  if (ctx.units.size >= MAX_UNITS) {
    ctx.ok = false;
    return;
  }
  ctx.units.add(t);
}

/** Analyze `script` as shell text, adding what it finds to `ctx`. Never throws. */
export function analyzeInto(script: string, ctx: Ctx): void {
  if (ctx.budget.depth >= MAX_DEPTH || script.length > MAX_INPUT) {
    ctx.ok = false;
    emit(ctx, script);
    return;
  }
  ctx.budget.depth++;
  try {
    const p = new Parser(script, ctx);
    const cmds = p.scan(false);
    p.processAll(cmds);
  } catch {
    ctx.ok = false;
    emit(ctx, script);
  } finally {
    ctx.budget.depth--;
  }
}

/** Parse a command as POSIX shell. */
export function analyzeShell(raw: string): Analysis {
  const ctx = newCtx();
  if (raw.length > MAX_INPUT) return { ok: false, units: [], single: false };
  analyzeInto(raw, ctx);
  return { ok: ctx.ok, units: [...ctx.units], single: ctx.ok && !ctx.complex && ctx.simple === 1 };
}

class Parser {
  i = 0;
  private pending: PendingHeredoc[] = [];
  constructor(
    readonly s: string,
    readonly ctx: Ctx,
  ) {}

  private fail(): void {
    this.ctx.ok = false;
  }

  /** Read commands until the end of the text, or (inside `$(`/`(`) until the matching `)`. */
  scan(inParen: boolean): Cmd[] {
    const s = this.s;
    const out: Cmd[] = [];
    let cmd = newCmd();
    let word: Word | null = null;
    let redir: { op: string; fd?: string } | null = null;

    const attach = (w: Word) => {
      if (cmd.start < 0) cmd.start = w.at;
      if (redir) {
        cmd.redirs.push({ ...redir, target: w });
        if (redir.op === "<<" || redir.op === "<<-") this.pending.push({ cmd, delim: w.val, strip: redir.op === "<<-", quoted: w.quoted || /[\\'"]/.test(w.raw) });
        redir = null;
      } else cmd.words.push(w);
    };
    const endWord = () => {
      if (word) {
        attach(word);
        word = null;
      }
    };
    const flush = (sep: string) => {
      endWord();
      if (redir) {
        this.fail(); // a redirection with no target
        redir = null;
      }
      if (cmd.words.length || cmd.redirs.length) {
        cmd.end = this.i;
        cmd.sep = sep;
        out.push(cmd);
      }
      cmd = newCmd();
    };
    const w = (): Word => (word ??= { raw: "", val: "", quoted: false, at: this.i });

    while (this.i < s.length) {
      const c = s[this.i]!;
      if (c === "\\") {
        if (s[this.i + 1] === "\n") {
          this.i += 2;
          continue;
        }
        if (s[this.i + 1] === "\r" && s[this.i + 2] === "\n") {
          this.i += 3;
          continue;
        }
        const ww = w();
        if (this.i + 1 < s.length) {
          ww.raw += s.slice(this.i, this.i + 2);
          ww.val += s[this.i + 1];
          ww.quoted = true;
          this.i += 2;
        } else {
          ww.raw += c;
          ww.val += c;
          this.i++;
        }
      } else if (c === "'") {
        const j = s.indexOf("'", this.i + 1);
        const ww = w();
        ww.quoted = true;
        if (j < 0) {
          this.fail();
          ww.raw += s.slice(this.i);
          ww.val += s.slice(this.i + 1);
          this.i = s.length;
        } else {
          ww.raw += s.slice(this.i, j + 1);
          ww.val += s.slice(this.i + 1, j);
          this.i = j + 1;
        }
      } else if (c === '"') {
        this.doubleQuoted(w());
      } else if (c === "$") {
        this.dollar(w());
      } else if (c === "`") {
        this.backtick(w());
      } else if (c === " " || c === "\t" || c === "\r") {
        endWord();
        this.i++;
      } else if (c === "\n") {
        flush("\n");
        this.i++;
        if (this.pending.length) this.readHeredocs();
      } else if (c === "#" && !word) {
        const j = s.indexOf("\n", this.i);
        this.i = j < 0 ? s.length : j;
      } else if (c === ";" || c === "&" || c === "|") {
        if (c === "&" && s[this.i + 1] === ">") {
          endWord();
          const op = s[this.i + 2] === ">" ? "&>>" : "&>";
          redir = { op };
          this.i += op.length;
          continue;
        }
        const two = s.slice(this.i, this.i + 2);
        const three = s.slice(this.i, this.i + 3);
        let len = 1;
        if (three === ";;&") len = 3;
        else if (two === ";;" || two === ";&" || two === "&&" || two === "||" || two === "|&") len = 2;
        const sep = s.slice(this.i, this.i + len);
        flush(sep);
        this.i += len;
      } else if (c === "(") {
        if (word && /^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test((word as Word).raw)) {
          // array assignment: name=( ... )
          const ww = w();
          const end = this.skipBalanced(this.i, "(", ")");
          ww.raw += s.slice(this.i, end);
          ww.val += s.slice(this.i, end);
          this.i = end;
        } else if (!word && cmd.words.length === 0 && !redir) {
          this.ctx.complex = true;
          this.i++;
          const inner = this.scan(true);
          this.processAll(inner);
        } else {
          // `name() {` function definitions and the like
          this.fail();
          this.i++;
        }
      } else if (c === ")") {
        if (inParen) {
          flush(")");
          this.i++;
          return out;
        }
        this.fail();
        this.i++;
      } else if (c === "<" || c === ">") {
        if (s[this.i + 1] === "(") {
          // process substitution: <(cmd) / >(cmd) is a word
          const ww = w();
          const startAt = this.i;
          this.ctx.complex = true;
          this.i += 2;
          const inner = this.scan(true);
          this.processAll(inner);
          ww.raw += s.slice(startAt, this.i);
          ww.val += s.slice(startAt, this.i);
          continue;
        }
        let fd: string | undefined;
        if (word && /^[0-9]+$/.test((word as Word).raw)) {
          fd = (word as Word).raw;
          word = null;
        } else endWord();
        const ops = c === ">" ? [">>", ">&", ">|", ">"] : ["<<<", "<<-", "<<", "<&", "<>", "<"];
        const op = ops.find((o) => s.startsWith(o, this.i))!;
        if (redir) this.fail();
        redir = { op, ...(fd !== undefined ? { fd } : {}) };
        if (op === "<<<" || op === "<<" || op === "<<-") this.ctx.complex = true;
        this.i += op.length;
      } else {
        const ww = w();
        ww.raw += c;
        ww.val += c;
        this.i++;
      }
    }
    if (inParen) this.fail(); // ran out of text before the closing )
    flush("");
    return out;
  }

  /** Index just past the bracket that closes the one at `from` (quotes inside are skipped). */
  private skipBalanced(from: number, open: string, close: string): number {
    const s = this.s;
    let depth = 0;
    let j = from;
    while (j < s.length) {
      const c = s[j]!;
      if (c === "\\") j++;
      else if (c === "'") {
        const k = s.indexOf("'", j + 1);
        if (k < 0) break;
        j = k;
      } else if (c === '"') {
        j++;
        while (j < s.length && s[j] !== '"') {
          if (s[j] === "\\") j++;
          j++;
        }
      } else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) return j + 1;
      }
      j++;
    }
    this.fail();
    return s.length;
  }

  private doubleQuoted(ww: Word): void {
    const s = this.s;
    ww.quoted = true;
    const start = this.i;
    this.i++;
    let val = "";
    while (this.i < s.length && s[this.i] !== '"') {
      const c = s[this.i]!;
      if (c === "\\" && this.i + 1 < s.length) {
        const n = s[this.i + 1]!;
        val += "$`\"\\".includes(n) ? n : n === "\n" ? "" : c + n;
        this.i += 2;
      } else if (c === "$" || c === "`") {
        const tmp: Word = { raw: "", val: "", quoted: true, at: this.i };
        if (c === "$") this.dollar(tmp);
        else this.backtick(tmp);
        val += tmp.val;
      } else {
        val += c;
        this.i++;
      }
    }
    if (this.i >= s.length) {
      this.fail(); // unterminated "
      ww.raw += s.slice(start);
      ww.val += val;
      return;
    }
    this.i++; // closing quote
    ww.raw += s.slice(start, this.i);
    ww.val += val;
  }

  /** `$'...'`, `$((...))`, `$(...)`, `${...}`, or a plain `$`. */
  private dollar(ww: Word): void {
    const s = this.s;
    const n = s[this.i + 1];
    const start = this.i;
    if (n === "'") {
      const j = this.closingSingle(this.i + 2);
      ww.quoted = true;
      if (j < 0) {
        this.fail();
        ww.raw += s.slice(start);
        ww.val += s.slice(start + 2);
        this.i = s.length;
      } else {
        ww.raw += s.slice(start, j + 1);
        ww.val += decodeEscapes(s.slice(start + 2, j));
        this.i = j + 1;
      }
    } else if (n === "(" && s[this.i + 2] === "(") {
      const end = this.skipBalanced(this.i + 1, "(", ")");
      ww.raw += s.slice(start, end);
      ww.val += s.slice(start, end);
      this.i = end;
    } else if (n === "(") {
      this.ctx.complex = true;
      this.i += 2;
      const inner = this.scan(true);
      this.processAll(inner);
      ww.raw += s.slice(start, this.i);
      ww.val += s.slice(start, this.i);
    } else if (n === "{") {
      const end = this.skipBalanced(this.i + 1, "{", "}");
      ww.raw += s.slice(start, end);
      ww.val += s.slice(start, end);
      this.i = end;
    } else {
      ww.raw += "$";
      ww.val += "$";
      this.i++;
    }
  }

  /** The closing quote of a $'...' string (a backslash escapes the next character). */
  private closingSingle(from: number): number {
    for (let j = from; j < this.s.length; j++) {
      if (this.s[j] === "\\") j++;
      else if (this.s[j] === "'") return j;
    }
    return -1;
  }

  private backtick(ww: Word): void {
    const s = this.s;
    const start = this.i;
    let j = this.i + 1;
    while (j < s.length && s[j] !== "`") j += s[j] === "\\" ? 2 : 1;
    this.ctx.complex = true;
    if (j >= s.length) {
      this.fail();
      ww.raw += s.slice(start);
      ww.val += s.slice(start);
      this.i = s.length;
      return;
    }
    const inner = s.slice(start + 1, j).replace(/\\([`\\$])/g, "$1");
    analyzeInto(inner, this.ctx);
    ww.raw += s.slice(start, j + 1);
    ww.val += s.slice(start, j + 1);
    this.i = j + 1;
  }

  private readHeredocs(): void {
    const s = this.s;
    for (const h of this.pending) {
      let body = "";
      let found = false;
      while (this.i <= s.length && !found) {
        if (this.i >= s.length) break;
        let le = s.indexOf("\n", this.i);
        if (le < 0) le = s.length;
        const line = s.slice(this.i, le).replace(/\r$/, "");
        const cmp = h.strip ? line.replace(/^\t+/, "") : line;
        this.i = Math.min(le + 1, s.length);
        if (cmp === h.delim) found = true;
        else body += line + "\n";
      }
      if (!found) this.fail();
      h.cmd.heredocs.push({ body, quoted: h.quoted });
    }
    this.pending = [];
  }

  /* ---------------------------------------------------------------- what each command means */

  processAll(cmds: Cmd[]): void {
    for (let k = 0; k < cmds.length; k++) this.process(cmds[k]!, cmds[k + 1]);
  }

  private process(cmd: Cmd, next: Cmd | undefined): void {
    const ctx = this.ctx;
    const source = this.s.slice(Math.max(cmd.start, 0), cmd.end).trim();
    let words = cmd.words;
    // leading reserved words (if/then/do/{...) and `for x in ...` / `function f` headers are not commands
    let dropped = false;
    while (words.length && RESERVED.has(words[0]!.val) && !words[0]!.quoted) {
      const head = words[0]!.val;
      if (head === "for" || head === "select" || head === "case" || head === "function" || head === "coproc" || head === "in") {
        words = [];
        dropped = true;
        break;
      }
      words = words.slice(1);
      dropped = true;
    }
    if (!words.length) {
      for (const r of cmd.redirs) if (r.target) ctx.complex = true;
      return;
    }
    // NAME=value words before the command
    const env = new Map<string, string>();
    let a = 0;
    while (a < words.length && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(words[a]!.raw)) {
      const eq = words[a]!.val.indexOf("=");
      const name = words[a]!.val.slice(0, eq).replace(/\+$/, "");
      const value = words[a]!.val.slice(eq + 1);
      env.set(name, value);
      a++;
    }
    if (a === words.length) {
      // only assignments: they stay in force for the rest of the script, so remember literal values
      for (const [k, v] of env) {
        if (/[$`]/.test(v)) ctx.vars.delete(k);
        else ctx.vars.set(k, v);
      }
      emit(ctx, source);
      ctx.complex = true;
      return;
    }
    ctx.simple++;
    if (dropped || cmd.heredocs.length || a > 0) ctx.complex = true;
    const subst = (v: string) =>
      v.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (m, b: string | undefined, c: string | undefined) => {
        const name = (b ?? c)!;
        const val = env.get(name) ?? ctx.vars.get(name);
        if (val === undefined) return m;
        ctx.complex = true;
        return val;
      });
    const vals = words.slice(a).map((x) => subst(x.val));
    emit(ctx, source);
    const joined = vals.join(" ");
    if (joined !== source) emit(ctx, joined);

    const inner = stripWrappers(vals);
    if (inner && inner.length) {
      ctx.complex = true;
      emit(ctx, inner.join(" "));
    }
    const argv = inner && inner.length ? inner : vals;
    this.unwrap(argv, cmd, next);
  }

  /** Look inside commands that run other code: shells, interpreters, eval, ssh, find -exec, and wrappers like `docker exec c bash -c ...`. */
  private unwrap(argv: string[], cmd: Cmd, next: Cmd | undefined): void {
    const ctx = this.ctx;
    const name = baseName(argv[0]!);
    const args = argv.slice(1);
    const body = (): string => cmd.heredocs.map((h) => h.body).join("\n");
    const piped = !!next && (cmd.sep === "|" || cmd.sep === "|&") && (SHELLS.has(baseName(next.words[0]?.val ?? "")) || INTERPRETERS.has(baseName(next.words[0]?.val ?? "")));

    if (SHELLS.has(name)) {
      const script = scriptAfterFlag(args, /^-[A-Za-z]*c[A-Za-z]*$/, new Set(["-o", "-O", "+o", "+O", "--rcfile", "--init-file"]));
      if (script !== undefined) {
        ctx.complex = true;
        analyzeInto(script, ctx);
      }
      // `bash <<EOF ... EOF` and `bash <<< "..."` read the script from stdin
      for (const h of cmd.heredocs) {
        ctx.complex = true;
        analyzeInto(h.body, ctx);
      }
      for (const r of cmd.redirs) if (r.op === "<<<" && r.target) analyzeInto(r.target.val, ctx);
      return;
    }
    if (name === "eval") {
      ctx.complex = true;
      analyzeInto(args.join(" "), ctx);
      return;
    }
    if (INTERPRETERS.has(name) || name.startsWith("python") || name.startsWith("pypy")) {
      const code = interpreterCode(name, args);
      if (code !== undefined) {
        ctx.complex = true;
        inlineCode(code, ctx);
      }
      for (const h of cmd.heredocs) {
        ctx.complex = true;
        inlineCode(h.body, ctx);
      }
      return;
    }
    if (name === "find" || name === "fd") {
      for (let k = 0; k < args.length; k++) {
        if (/^-(exec|execdir|ok|okdir)$/.test(args[k]!) || (name === "fd" && /^(-x|-X|--exec|--exec-batch)$/.test(args[k]!))) {
          const parts: string[] = [];
          for (k++; k < args.length && args[k] !== ";" && args[k] !== "+"; k++) parts.push(args[k]!);
          if (parts.length) {
            ctx.complex = true;
            analyzeInto(quoteJoin(parts), ctx); // -exec takes separate arguments, so quote them as a shell would need
          }
        }
      }
      return;
    }
    if (name === "ssh" || name === "mosh") {
      const rest = remoteCommand(args);
      if (rest) {
        ctx.complex = true;
        analyzeInto(rest, ctx);
      }
      return;
    }
    if (name === "su" || name === "runuser" || name === "script") {
      const script = scriptAfterFlag(args, /^-[A-Za-z]*c$/, new Set());
      if (script !== undefined) {
        ctx.complex = true;
        analyzeInto(script, ctx);
      }
      return;
    }
    // a heredoc/stdin fed to a shell further down the pipe: `cat <<EOF | sh`
    if (piped && cmd.heredocs.length) {
      ctx.complex = true;
      analyzeInto(body(), ctx);
    }
    // another program that runs a shell or interpreter: docker exec c bash -c "...", kubectl exec -- sh -c "...", nsenter ... python -c "..."
    for (let k = 1; k < argv.length; k++) {
      const n = baseName(argv[k]!);
      if (SHELLS.has(n) || INTERPRETERS.has(n) || n.startsWith("python")) {
        this.unwrap(argv.slice(k), cmd, next);
        break;
      }
    }
  }
}

/* -------------------------------------------------------------------- wrappers and interpreters */

const INTERPRETERS = new Set(["node", "nodejs", "bun", "deno", "perl", "ruby", "php", "lua", "awk", "gawk", "mawk", "nawk", "osascript", "rscript", "tclsh", "groovy", "py", "python", "python2", "python3"]);

/** Wrapper programs and the options of theirs that take a value. Returns the command they run, or null when `argv` is not a wrapper call. */
export function stripWrappers(argv: string[]): string[] | null {
  let words = argv;
  let stripped = false;
  for (let guard = 0; guard < 8 && words.length; guard++) {
    const n = baseName(words[0]!);
    const valued: Record<string, string[]> = {
      sudo: ["-u", "-g", "-h", "-p", "-C", "-T", "-r", "-t", "-U", "-D", "-R"],
      doas: ["-u", "-C"],
      env: ["-u", "-C", "-S", "-P"],
      exec: ["-a"],
      nice: ["-n"],
      ionice: ["-c", "-n", "-p", "-P", "-u"],
      stdbuf: ["-i", "-o", "-e"],
      xargs: ["-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a", "-l", "-i"],
      watch: ["-n", "-d"],
      timeout: ["-s", "-k", "--signal", "--kill-after"],
    };
    if (!(n in valued) && !["command", "builtin", "nohup", "setsid", "time", "unbuffer", "caffeinate", "chronic", "busybox"].includes(n)) break;
    let k = 1;
    const takes = new Set(valued[n] ?? []);
    while (k < words.length) {
      const w = words[k]!;
      if (w === "--") {
        k++;
        break;
      }
      if (w.startsWith("-") && w.length > 1) {
        k += takes.has(w) ? 2 : 1;
        continue;
      }
      if (n === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
        k++;
        continue;
      }
      if (n === "timeout" && k < words.length && /^[0-9.]+[smhd]?$/.test(w)) {
        k++;
        break;
      }
      break;
    }
    words = words.slice(k);
    stripped = true;
  }
  return stripped ? words : null;
}

/** The word after the first option cluster matching `flag` (e.g. the script of `bash -lc "..."`), skipping options that take a value. */
function scriptAfterFlag(args: string[], flag: RegExp, valued: Set<string>): string | undefined {
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (valued.has(a)) {
      k++;
      continue;
    }
    if (flag.test(a)) {
      // options after the -c cluster may still precede the script (`bash -c -x "..."` is rare); the first non-option is the script
      for (let m = k + 1; m < args.length; m++) if (!args[m]!.startsWith("-") || args[m] === "-") return args[m];
      return undefined;
    }
    if (!a.startsWith("-") && a !== "-") return undefined; // reached the script file name: no inline code
  }
  return undefined;
}

/** The inline code of an interpreter call (`python -c CODE`, `node -e CODE`, `perl -e CODE`, `ruby -e`, `php -r`, awk's program), if any. */
function interpreterCode(name: string, args: string[]): string | undefined {
  const flagsFor = (): RegExp | undefined => {
    if (name.startsWith("python") || name.startsWith("pypy") || name === "py") return /^-[A-Za-z]*c$/;
    if (["node", "nodejs", "bun"].includes(name)) return /^(-[A-Za-z]*[ep]|--eval|--print)$/;
    if (name === "deno") return undefined;
    if (name === "perl") return /^-[A-Za-z]*[eE]$/;
    if (name === "ruby" || name === "lua" || name === "osascript" || name === "rscript" || name === "groovy") return /^-[A-Za-z]*e$/;
    if (name === "php") return /^-[A-Za-z]*r$/;
    return undefined;
  };
  if (name === "deno") return args[0] === "eval" ? args.slice(1).filter((a) => !a.startsWith("-")).join(" ") : undefined;
  if (["awk", "gawk", "mawk", "nawk"].includes(name)) {
    for (let k = 0; k < args.length; k++) {
      const a = args[k]!;
      if (a === "-F" || a === "-v" || a === "-f") k++;
      else if (!a.startsWith("-")) return a;
    }
    return undefined;
  }
  const f = flagsFor();
  if (!f) return undefined;
  for (let k = 0; k < args.length; k++) {
    if (f.test(args[k]!) && k + 1 < args.length) return args[k + 1];
  }
  return undefined;
}

/** Join separate arguments into one shell command line, quoting the ones that need it. */
function quoteJoin(words: string[]): string {
  return words.map((w) => (/^[A-Za-z0-9_@%+=:,./{}-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`)).join(" ");
}

/** What `ssh [options] host command...` runs on the other side. */
function remoteCommand(args: string[]): string | undefined {
  const valued = new Set(["-p", "-i", "-o", "-l", "-J", "-L", "-R", "-D", "-F", "-b", "-c", "-e", "-m", "-E", "-I", "-O", "-S", "-w", "-B", "-Q", "-W"]);
  let k = 0;
  while (k < args.length && args[k]!.startsWith("-")) k += valued.has(args[k]!) ? 2 : 1;
  k++; // the host
  return k < args.length ? args.slice(k).join(" ") : undefined;
}

/* -------------------------------------------------------------------- code in other languages */

const LITERAL = /(["'`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g;

/** Text a rule should also see for code that is not shell: the code itself, its string literals joined the way a call joins them, decoded escapes, and decoded base64. */
export function inlineCode(code: string, ctx: Ctx): void {
  emit(ctx, code);
  const decoded = decodeEscapes(code);
  if (decoded !== code) emit(ctx, decoded);
  const lits: Array<{ text: string; start: number; end: number }> = [];
  LITERAL.lastIndex = 0;
  for (let m = LITERAL.exec(code); m && lits.length < 300; m = LITERAL.exec(code)) lits.push({ text: decodeEscapes(m[2]!), start: m.index, end: m.index + m[0].length });
  // runs of literals separated only by commas, plus signs and brackets: ["rm", "-rf", "/"]  or  'r' + 'm -rf /'
  let run: string[] = [];
  const closeRun = () => {
    if (run.length > 1) {
      emit(ctx, run.join(" "));
      emit(ctx, run.join(""));
    }
    run = [];
  };
  let prevEnd = -1;
  for (const l of lits) {
    if (prevEnd >= 0 && !/^[\s,+\[\]()]*$/.test(code.slice(prevEnd, l.start))) closeRun();
    run.push(l.text);
    prevEnd = l.end;
    const b = decodeBase64Text(l.text);
    if (b) {
      emit(ctx, b);
      ctx.complex = true;
    }
  }
  closeRun();
}

/** Decode base64 that holds readable text (a command smuggled as a blob). Returns undefined when it is not that. */
export function decodeBase64Text(s: string): string | undefined {
  const t = s.trim();
  if (t.length < 12 || t.length > 20_000 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) return undefined;
  try {
    const buf = Buffer.from(t.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const text = buf.toString("utf8");
    return /^[\x09\x0a\x0d\x20-\x7e]{6,}$/.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}
