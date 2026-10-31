import { identityOf, normalizeCommandLine, normalizeUrl } from "./mcp/identity.js";
import { addAllowEntry, loadMcpPolicy, matchAllow, mcpPolicyPath, setMcpMode, type McpMode, type McpPolicy } from "./mcp/policy.js";
import { listAllServers, type ConfiguredServer, type ServerLookup } from "./mcp/servers.js";

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

export interface McpCmdOptions extends ServerLookup {
  policyFile?: string;
}

const statusOf = (policy: McpPolicy, s: ConfiguredServer) => (matchAllow(policy, s.def) ? "allowed" : policy.mode === "enforce" ? "BLOCKED" : "not listed");

/** `cephalo mcp` / `cephalo mcp list` */
export function listMcp(o: McpCmdOptions = {}): { lines: string[]; exitCode: number } {
  const file = o.policyFile ?? mcpPolicyPath();
  const policy = loadMcpPolicy(file);
  const servers = listAllServers(o);
  const lines = [`MCP policy: ${file}`, `Mode: ${policy.mode}${policy.mode === "audit" ? "  (calls are logged, nothing is blocked)" : "  (servers not on the allowlist are blocked)"}`, ""];
  if (servers.length === 0) {
    lines.push("No MCP servers are configured for Claude Code (here) or Hermes.");
  } else {
    const nw = Math.max(4, ...servers.map((s) => s.name.length));
    lines.push(`${pad("NAME", nw)}  ${pad("AGENT/SCOPE", 15)}  ${pad("STATUS", 10)}  RUNS / LIVES AT`);
    for (const s of servers) {
      lines.push(`${pad(s.name, nw)}  ${pad(s.source.replace("claude-", "claude/"), 15)}  ${pad(statusOf(policy, s), 10)}  ${s.identity}`);
    }
  }
  lines.push("");
  lines.push(`Allowlist: ${policy.allow.length} entr${policy.allow.length === 1 ? "y" : "ies"}. Entries match a server's command or URL, never its name.`);
  const unlisted = servers.filter((s) => !matchAllow(policy, s.def));
  if (unlisted.length) lines.push(`${unlisted.length} configured server(s) are not on the allowlist. Approve one with: cephalo mcp allow <name>`);
  return { lines, exitCode: 0 };
}

export interface AllowTarget {
  /** A configured server's name (used only to look it up here). */
  name?: string;
  /** Restrict a name lookup to one source, e.g. "hermes" or "claude". */
  source?: string;
  command?: string;
  url?: string;
}

export interface AllowPlan {
  ok: boolean;
  lines: string[];
  entry?: { command?: string; url?: string; label?: string };
}

/** Work out exactly what would be added, without changing anything. */
export function planAllow(t: AllowTarget, o: McpCmdOptions = {}): AllowPlan {
  if (t.command) {
    const norm = normalizeCommandLine(t.command.split(/\s+/)[0], []);
    return { ok: true, lines: [`Allow servers that run: ${t.command}`, `  (executable normalized to "${norm}")`], entry: { command: t.command } };
  }
  if (t.url) {
    return { ok: true, lines: [`Allow servers at: ${normalizeUrl(t.url)}`], entry: { url: t.url } };
  }
  if (!t.name) return { ok: false, lines: ["Usage: cephalo mcp allow <server-name> | --command \"<command line>\" | --url <url>   [--yes]"] };
  let found = listAllServers(o).filter((s) => s.name === t.name);
  if (t.source) found = found.filter((s) => s.source === t.source || s.source.startsWith(`${t.source}-`));
  if (found.length === 0) return { ok: false, lines: [`No configured MCP server named "${t.name}". See: cephalo mcp list`] };
  const ids = [...new Set(found.map((s) => s.identity))];
  if (ids.length > 1) {
    return { ok: false, lines: [`"${t.name}" is defined more than once with different commands/URLs. Pick one with --source, or use --command / --url:`, ...found.map((s) => `  ${s.source}: ${s.identity}`)] };
  }
  const s = found[0];
  const entry = s.def.kind === "http" ? { url: s.def.url! } : { command: [s.def.command!, ...(s.def.args ?? [])].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ") };
  return {
    ok: true,
    lines: [`Allow ${s.def.kind === "http" ? "URL" : "command"}: ${s.identity.replace(/^(cmd|url):/, "")}`, `  from ${s.source} config (${s.origin}); the name "${s.name}" is only recorded as a label`],
    entry: { ...entry, label: s.name },
  };
}

export function applyAllow(plan: AllowPlan, o: McpCmdOptions = {}): string[] {
  if (!plan.ok || !plan.entry) return plan.lines;
  const file = o.policyFile ?? mcpPolicyPath();
  const r = addAllowEntry(plan.entry, file);
  return [r.added ? `Added to ${file}` : "Already on the allowlist. Nothing changed.", ...(r.backup ? [`Backup: ${r.backup}`] : [])];
}

export function planMode(mode: string, o: McpCmdOptions = {}): { ok: boolean; lines: string[]; mode?: McpMode } {
  if (mode !== "audit" && mode !== "enforce") return { ok: false, lines: ["Usage: cephalo mcp mode audit|enforce   [--yes]"] };
  const policy = loadMcpPolicy(o.policyFile ?? mcpPolicyPath());
  const lines = [`Switch MCP mode from ${policy.mode} to ${mode}.`];
  if (mode === "enforce") {
    const unlisted = listAllServers(o).filter((s) => !matchAllow(policy, s.def));
    lines.push(unlisted.length ? `${unlisted.length} configured server(s) are NOT on the allowlist and their tools will be blocked:` : "Every configured server is on the allowlist.");
    for (const s of unlisted) lines.push(`  ${s.name}  ->  ${s.identity}`);
    lines.push("Servers Cephalo cannot find in the agent config (for example plugin-bundled ones) are blocked too, because they cannot be verified.");
  }
  return { ok: true, lines, mode };
}

export function applyMode(mode: McpMode, o: McpCmdOptions = {}): string[] {
  const file = o.policyFile ?? mcpPolicyPath();
  const r = setMcpMode(mode, file);
  return [r.changed ? `MCP mode is now ${mode} (${file})` : `Already in ${mode} mode. Nothing changed.`, ...(r.backup ? [`Backup: ${r.backup}`] : [])];
}

/** One-line summary for `doctor`. */
export function mcpSummary(o: McpCmdOptions = {}): { mode: McpMode; servers: number; unlisted: number; entries: number } {
  const policy = loadMcpPolicy(o.policyFile ?? mcpPolicyPath());
  const servers = listAllServers(o);
  return { mode: policy.mode, servers: servers.length, unlisted: servers.filter((s) => !matchAllow(policy, s.def)).length, entries: policy.allow.length };
}

export { identityOf };
