/**
 * Turn one thing an agent did into candidate rules, from narrow to broad.
 * Everything here is heuristic text work: it reads a command or path and proposes regular expressions. The caller then
 * checks each proposal (does it compile, is it slow, does it catch the incident, what else in the history would it block).
 */

export interface Candidate {
  /** "narrow" catches little beyond the incident, "broad" can catch a lot of ordinary work. */
  level: "narrow" | "balanced" | "broad";
  title: string;
  type: "command" | "path";
  on?: "read" | "write" | "any";
  pattern: string;
  /** Used for the rule id and description. */
  slug: string;
  recommended?: boolean;
}

/* ------------------------------------------------------------------ shell text */

/** Split a command line into segments at unquoted &&, ||, ;, | and newlines. */
export function splitSegments(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      cur += c;
      if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
      continue;
    }
    if (c === "\n" || c === ";" || c === "|" || (c === "&" && cmd[i + 1] === "&")) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      if ((c === "|" && cmd[i + 1] === "|") || c === "&") i++;
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Split one segment into words, honouring quotes. Backslashes are kept as they are (Windows paths). */
export function tokenize(seg: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  let has = false;
  for (const c of seg) {
    if (q) {
      if (c === q) q = null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
      continue;
    }
    cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** A path or host fragment with any slash style accepted. */
const pathRe = (s: string) => s.split(/[\\/]+/).filter(Boolean).map(escapeRe).join("[\\\\/]");

const WRAPPERS = new Set(["sudo", "doas", "env", "time", "nohup", "nice", "command", "exec", "call", "start"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const SUBCOMMAND_TOOLS = new Set(["git", "npm", "pnpm", "yarn", "docker", "kubectl", "gh", "aws", "az", "gcloud", "pip", "pip3", "cargo", "systemctl", "apt", "apt-get", "brew", "helm", "terraform", "go", "dotnet", "winget", "choco", "scoop", "nuget", "reg", "netsh", "sc", "schtasks", "vssadmin", "wmic", "diskutil", "launchctl", "defaults", "gem", "composer", "poetry", "uv", "flyctl", "heroku", "vercel", "firebase", "supabase"]);
const VALUE_FLAGS: Record<string, Set<string>> = { git: new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]) };
const NETWORK = new Set(["curl", "wget", "iwr", "irm", "invoke-webrequest", "invoke-restmethod", "nc", "ncat", "netcat", "scp", "sftp", "ssh", "rsync", "ftp", "telnet", "http", "https"]);
const READERS = new Set(["cat", "type", "get-content", "gc", "less", "more", "head", "tail", "cp", "copy", "mv", "move", "tar", "zip", "7z", "base64", "xxd", "strings", "scp", "rsync"]);

const RISKY_LONG = new Set(["--force", "--hard", "--recursive", "--no-preserve-root", "--delete", "--purge", "--prune", "--yes", "--no-verify", "--insecure", "--privileged", "--no-check-certificate", "--force-reinstall", "--allow-unauthenticated", "--skip-ssl", "--unsafe-perm"]);
const RISKY_SHORT = new Set(["-f", "-F", "-D", "-y", "-k", "-r", "-R", "-rf", "-fr", "-Rf", "-fR"]);

export interface Parsed {
  exe: string;
  sub?: string;
  /** Flag names as typed (values after "=" removed). */
  flags: string[];
  args: string[];
  text: string;
  /** If the command ran another shell (bash -c "...", powershell -Command ...), the inner command line. */
  inner?: string;
}

const baseExe = (t: string) => (t.split(/[\\/]/).pop() ?? t).replace(/\.(exe|cmd|bat|ps1|com)$/i, "").toLowerCase();

/** Pick the interesting part of a segment: skip env assignments and wrappers, unwrap `bash -c "..."`. */
export function parseSegment(seg: string, depth = 0): Parsed | null {
  let toks = tokenize(seg);
  while (toks.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0]) || WRAPPERS.has(baseExe(toks[0])))) toks = toks.slice(1);
  if (!toks.length) return null;
  const exe = baseExe(toks[0]);
  if (depth < 3) {
    let inner: string | undefined;
    if (SHELLS.has(exe)) {
      const i = toks.findIndex((t, k) => k > 0 && /^-[a-z]*c$/.test(t));
      if (i > 0 && toks[i + 1]) inner = toks[i + 1];
    } else if (exe === "powershell" || exe === "pwsh") {
      const i = toks.findIndex((t, k) => k > 0 && /^-(c|command)$/i.test(t));
      if (i > 0 && toks[i + 1]) inner = toks.slice(i + 1).join(" ");
    } else if (exe === "cmd") {
      const i = toks.findIndex((t, k) => k > 0 && /^\/[ck]$/i.test(t));
      if (i > 0 && toks[i + 1]) inner = toks.slice(i + 1).join(" ");
    }
    if (inner) {
      const segs = splitSegments(inner);
      const pick = pickSegment(segs);
      const p = pick !== null ? parseSegment(segs[pick], depth + 1) : null;
      if (p) return { ...p, inner };
    }
  }
  const rest = toks.slice(1);
  const flags: string[] = [];
  const args: string[] = [];
  let sub: string | undefined;
  const valueFlags = VALUE_FLAGS[exe];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (valueFlags?.has(t)) {
      i++;
      continue;
    }
    if (/^-{1,2}[A-Za-z]/.test(t)) {
      flags.push(t.includes("=") ? t.slice(0, t.indexOf("=")) : t);
      continue;
    }
    if (/^\/[A-Za-z?]$/.test(t) && !/[\\/]/.test(t.slice(1))) {
      flags.push(t); // Windows switches such as /s /q
      continue;
    }
    if (sub === undefined && SUBCOMMAND_TOOLS.has(exe) && !t.includes("/") && !t.includes("\\") && !t.includes(".")) {
      sub = t.toLowerCase();
      continue;
    }
    args.push(t);
  }
  return { exe, sub, flags, args, text: seg };
}

const HARMFUL = new Set(["rm", "del", "rmdir", "rd", "remove-item", "dd", "mkfs", "format", "shred", "kill", "taskkill", "chmod", "chown", "reg", "netsh", "schtasks", "crontab", "truncate"]);
const QUIET = new Set(["cd", "echo", "ls", "dir", "pwd", "cat", "type", "true", "false", "set", "export", "source", "test", "printf", "sleep", "clear", "cls"]);

/**
 * Which segment of a chained command is the one worth a rule: the one that sends data out or destroys something wins,
 * then risky flags, then tools that change state; harmless navigation and printing never win. Ties go to the first.
 */
export function pickSegment(segs: string[]): number | null {
  if (!segs.length) return null;
  let best = 0;
  let bestScore = -1;
  segs.forEach((s, i) => {
    const p = parseSegment(s, 3);
    if (!p) return;
    let score = 0;
    if (QUIET.has(p.exe)) score = 0;
    else {
      score = 1;
      if (p.sub && !["test", "status", "ps", "get", "list", "ls", "view", "show", "diff", "log", "version", "help", "build", "run", "install", "ci", "i"].includes(p.sub)) score += 1;
      if (SUBCOMMAND_TOOLS.has(p.exe)) score += 1;
      if (p.flags.some(isRiskyFlag)) score += 3;
      if (HARMFUL.has(p.exe)) score += 3;
      if (NETWORK.has(p.exe)) score += 2 + (p.args.some((a) => hostOf(a)) ? 3 : 0);
    }
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}

/* ------------------------------------------------------------------ patterns */

const exeRe = (exe: string) => `\\b${escapeRe(exe)}(\\.exe|\\.cmd|\\.bat|\\.ps1)?\\b`;

function flagLook(flag: string): string {
  if (/^\/[A-Za-z?]$/.test(flag)) return `(?=[^\\n]*\\s${escapeRe(flag)}(?![\\w]))`;
  if (/^-[A-Za-z]{2,}$/.test(flag)) {
    // a cluster such as -rf: every letter must appear in one cluster, in any order
    const letters = [...new Set(flag.slice(1).toLowerCase())];
    return `(?=[^\\n]*\\s-${letters.map((l) => `(?=[a-z]*${l})`).join("")}[a-z]+)`;
  }
  return `(?=[^\\n]*\\s${escapeRe(flag)}(?![\\w-]))`;
}

const isRiskyFlag = (f: string) => RISKY_LONG.has(f.toLowerCase()) || RISKY_SHORT.has(f) || (/^-[A-Za-z]{2,}$/.test(f) && /[fr]/i.test(f.slice(1)));

const HOST_RE = /^(?:https?:\/\/|ftp:\/\/|ssh:\/\/)?(?:[^/\s:@]+@)?((?:[a-z0-9-]+\.)+[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#]|$)/i;
const hostOf = (arg: string): string | null => {
  const m = HOST_RE.exec(arg.replace(/^.*?=(?=https?:)/, ""));
  return m ? m[1].toLowerCase() : null;
};
const looksLikePath = (a: string) => /[\\/]/.test(a) && !/^[a-z]+:\/\//i.test(a) && !a.startsWith("/?") ;

const slugOf = (...parts: Array<string | undefined>) => parts.filter(Boolean).join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "rule";

export function commandCandidates(command: string, o: { segment?: number } = {}): { candidates: Candidate[]; segment: string; segments: string[]; note?: string } {
  const segments = splitSegments(command);
  const idx = o.segment !== undefined ? Math.min(Math.max(o.segment, 0), Math.max(segments.length - 1, 0)) : pickSegment(segments);
  const segment = idx === null ? command : segments[idx];
  const p = parseSegment(segment);
  if (!p) return { candidates: [], segment, segments, note: "Could not read a program name from that command." };

  const head = `${exeRe(p.exe)}${p.sub ? `\\s+${escapeRe(p.sub)}\\b` : ""}`;
  const what = `${p.exe}${p.sub ? ` ${p.sub}` : ""}`;
  const out: Candidate[] = [];
  const add = (c: Omit<Candidate, "type">) => {
    if (!out.some((x) => x.pattern === c.pattern)) out.push({ type: "command", ...c });
  };

  const flagNames = [...new Set(p.flags)];
  const risky = flagNames.filter(isRiskyFlag);

  // destination: where the data goes
  const hosts = [...new Set(p.args.map(hostOf).filter((h): h is string => !!h))];
  for (const h of hosts) {
    add({ level: "balanced", title: `${what} to ${h}`, pattern: `${exeRe(p.exe)}[^\\n]*${pathRe(h)}`, slug: slugOf(p.exe, h) });
    add({ level: "broad", title: `any command that mentions ${h}`, pattern: `(^|[^\\w.-])${pathRe(h)}($|[^\\w-])`, slug: slugOf("host", h) });
  }
  // a sensitive-looking path argument
  for (const a of p.args.filter(looksLikePath).slice(0, 2)) {
    const segs = a.replace(/^~/, "").split(/[\\/]+/).filter(Boolean);
    const tail = segs.slice(-2);
    if (tail.length) add({ level: "balanced", title: `any command that touches ${tail.join("/")}`, pattern: `(^|[\\s"'\\\\/])${tail.map(escapeRe).join("[\\\\/]")}($|[\\s"'\\\\/])`, slug: slugOf("touch", ...tail) });
  }
  // the shape of the command
  if (flagNames.length) add({ level: "narrow", title: `${what} with ${flagNames.join(" ")}`, pattern: head + flagNames.map(flagLook).join(""), slug: slugOf(p.exe, p.sub, ...flagNames) });
  if (risky.length) add({ level: "balanced", title: `${what} with ${risky.join(" ")}`, pattern: head + risky.map(flagLook).join(""), slug: slugOf(p.exe, p.sub, ...risky) });
  if (p.sub) add({ level: "broad", title: `every ${what}`, pattern: head, slug: slugOf(p.exe, p.sub) });
  add({ level: "broad", title: `every use of ${p.exe}`, pattern: exeRe(p.exe), slug: slugOf(p.exe) });

  // recommendation
  let rec: Candidate | undefined;
  if (NETWORK.has(p.exe) && hosts.length) rec = out.find((c) => c.title === `${what} to ${hosts[0]}`);
  rec ??= risky.length ? out.find((c) => c.title === `${what} with ${risky.join(" ")}`) : undefined;
  rec ??= READERS.has(p.exe) ? out.find((c) => c.title.startsWith("any command that touches")) : undefined;
  rec ??= p.sub ? out.find((c) => c.title === `every ${what}`) : undefined;
  rec ??= out.find((c) => c.level === "balanced") ?? out[0];
  if (rec) rec.recommended = true;
  return { candidates: out, segment, segments };
}

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "write_file", "patch"]);
const SENSITIVE_DIRS = /^(\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.config|\.azure|secrets?|credentials?|private|\.git|\.cephalo|keys?)$/i;
const BORING_DIRS = new Set(["src", "lib", "app", "tmp", "temp", "home", "users", "var", "usr", "etc", "bin", "dist", "build", "node_modules", "documents", "desktop", "downloads", "appdata", "local", "roaming"]);

export function pathCandidates(rawPath: string, tool: string): Candidate[] {
  const segs = rawPath.replace(/^~/, "").split(/[\\/]+/).filter(Boolean);
  if (!segs.length) return [];
  const base = segs[segs.length - 1];
  const dir = segs.length > 1 ? segs[segs.length - 2] : undefined;
  const on: "read" | "write" = WRITE_TOOLS.has(tool) ? "write" : "read";
  const verb = on === "write" ? "writing" : "reading";
  const out: Candidate[] = [];
  const add = (c: Omit<Candidate, "type" | "on">) => out.push({ type: "path", on, ...c });
  add({ level: "narrow", title: `${verb} ${dir ? `${dir}/` : ""}${base}`, pattern: `${dir ? `${escapeRe(dir)}[\\\\/]` : "[\\\\/]"}${escapeRe(base)}$`.replace(/^(?!\[)/, "[\\\\/]"), slug: slugOf(on, dir, base) });
  if (dir && !BORING_DIRS.has(dir.toLowerCase())) add({ level: "balanced", title: `${verb} anything in ${dir}/`, pattern: `[\\\\/]${escapeRe(dir)}[\\\\/]`, slug: slugOf(on, dir) });
  add({ level: "balanced", title: `${verb} any file named ${base}`, pattern: `[\\\\/]${escapeRe(base)}$`, slug: slugOf(on, "file", base) });
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(base)?.[1];
  if (ext) add({ level: "broad", title: `${verb} any .${ext} file`, pattern: `\\.${escapeRe(ext)}$`, slug: slugOf(on, ext, "files") });
  const rec = (dir && SENSITIVE_DIRS.test(dir) ? out.find((c) => c.title.includes("anything in")) : undefined) ?? out[0];
  rec.recommended = true;
  return out;
}
