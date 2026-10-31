/**
 * MCP server identity. A server is identified by WHAT IT RUNS (its command line) or WHERE IT IS
 * (its URL), never by the name a config file happens to give it: names are free-form labels that
 * anyone can reuse or swap.
 */
export interface ServerDef {
  kind: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
}

const EXE_EXT = /\.(exe|cmd|bat|com)$/i;

/** Executable name only: no directory, no .exe/.cmd, lower case ("C:\\Program Files\\nodejs\\NPX.CMD" -> "npx"). */
export function normalizeExecutable(exe: string): string {
  const base = exe.trim().replace(/^["']|["']$/g, "").split(/[\\/]/).pop() ?? exe;
  return base.replace(EXE_EXT, "").toLowerCase();
}

const quoteArg = (a: string) => (/\s/.test(a) ? JSON.stringify(a) : a);

/** Split a command line the way a shell roughly would (double/single quotes, no escapes beyond \"). */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2] ?? m[3]);
  return out;
}

/** "cmd /c npx -y pkg" and "npx -y pkg" are the same server: unwrap the Windows cmd shim. */
function unwrap(exe: string, args: string[]): { exe: string; args: string[] } {
  if (exe === "cmd" && args.length >= 2 && /^\/[ck]$/i.test(args[0])) {
    const rest = args.slice(1);
    // `cmd /c "npx -y pkg"` passes the whole line as one argument
    const parts = rest.length === 1 ? splitCommandLine(rest[0]) : rest;
    return { exe: normalizeExecutable(parts[0] ?? ""), args: parts.slice(1) };
  }
  return { exe, args };
}

/** Canonical single-line form of a command + args. */
export function normalizeCommandLine(command: string, args: string[] = []): string {
  const first = unwrap(normalizeExecutable(command), args.map(String));
  return [first.exe, ...first.args.map(quoteArg)].join(" ").trim();
}

/** Same canonical form for a user-written allowlist string. */
export function normalizeCommandString(line: string): string {
  const parts = splitCommandLine(line.trim());
  if (!parts.length) return "";
  return normalizeCommandLine(parts[0], parts.slice(1));
}

/** Lower-case scheme+host, default port dropped, credentials/query/fragment dropped, no trailing slash. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.host}${path}`.toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

export function identityOf(def: ServerDef): string {
  return def.kind === "http" ? `url:${normalizeUrl(def.url ?? "")}` : `cmd:${normalizeCommandLine(def.command ?? "", def.args ?? [])}`;
}

/** Build a ServerDef from a raw config entry (Claude `mcpServers` item or Hermes `mcp_servers` item). */
export function defFromRaw(raw: unknown): ServerDef | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.url === "string" && o.url) return { kind: "http", url: o.url };
  if (typeof o.command === "string" && o.command) {
    return { kind: "stdio", command: o.command, args: Array.isArray(o.args) ? o.args.map(String) : [] };
  }
  return null;
}

/** `*` matches any run of characters; everything else is literal. Anchored. */
export function globToRegExp(pattern: string, flags = ""): RegExp {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${esc}$`, flags);
}

/** True if a pattern would match every possible value (only `*` characters). */
export const isMatchAll = (pattern: string) => /^\*+$/.test(pattern.trim());
