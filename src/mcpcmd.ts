import { listTools, type ListToolsFn } from "./mcp/client.js";
import { diffIsEmpty, diffTools, fingerprintServer, fingerprintTool, short, snapshotTool, type McpTool, type ToolDiff } from "./mcp/fingerprint.js";
import { identityOf, normalizeCommandLine, normalizeUrl } from "./mcp/identity.js";
import { addAllowEntry, loadMcpPolicy, matchAllow, mcpPolicyPath, setMcpMode, type McpMode, type McpPolicy } from "./mcp/policy.js";
import { listAllServers, type ConfiguredServer, type ServerLookup } from "./mcp/servers.js";
import { approvalStorePath, clearDrift, flagDrift, loadApprovals, pinServer } from "./mcp/store.js";
import { sanitize } from "./watch.js";

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

export interface McpCmdOptions extends ServerLookup {
  policyFile?: string;
  /** Where approved tool fingerprints live (default ~/.cephalo/mcp-tools.json). */
  approvalsFile?: string;
  /** Test hook: replaces the real MCP client. */
  list?: ListToolsFn;
  timeoutMs?: number;
}

const statusOf = (policy: McpPolicy, s: ConfiguredServer) => (matchAllow(policy, s.def) ? "allowed" : policy.mode === "enforce" ? "BLOCKED" : "not listed");

/** `cephalo mcp` / `cephalo mcp list` */
export function listMcp(o: McpCmdOptions = {}): { lines: string[]; exitCode: number } {
  const file = o.policyFile ?? mcpPolicyPath();
  const policy = loadMcpPolicy(file);
  const servers = listAllServers(o);
  const approvals = loadApprovals(o.approvalsFile ?? approvalStorePath());
  const lines = [`MCP policy: ${file}`, `Mode: ${policy.mode}${policy.mode === "audit" ? "  (calls are logged, nothing is blocked)" : "  (servers not on the allowlist are blocked)"}`, ""];
  if (servers.length === 0) {
    lines.push("No MCP servers are configured for Claude Code (here) or Hermes.");
  } else {
    const nw = Math.max(4, ...servers.map((s) => s.name.length));
    lines.push(`${pad("NAME", nw)}  ${pad("AGENT/SCOPE", 15)}  ${pad("STATUS", 10)}  RUNS / LIVES AT   [TOOLS]`);
    for (const s of servers) {
      const pin = approvals.servers[s.identity];
      const tools = !pin ? "" : pin.drift ? `   [CHANGED since approval: ${[...pin.drift.changed, ...pin.drift.added].join(", ") || "tools removed"}]` : `   [${Object.keys(pin.tools).length} tools pinned ${short(pin.fingerprint)}]`;
      lines.push(`${pad(s.name, nw)}  ${pad(s.source.replace("claude-", "claude/"), 15)}  ${pad(statusOf(policy, s), 10)}  ${s.identity}${tools}`);
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
export function mcpSummary(o: McpCmdOptions = {}): { mode: McpMode; servers: number; unlisted: number; entries: number; pinned: number; drifted: number } {
  const policy = loadMcpPolicy(o.policyFile ?? mcpPolicyPath());
  const servers = listAllServers(o);
  const approvals = loadApprovals(o.approvalsFile ?? approvalStorePath());
  return {
    mode: policy.mode,
    servers: servers.length,
    unlisted: servers.filter((s) => !matchAllow(policy, s.def)).length,
    entries: policy.allow.length,
    pinned: servers.filter((s) => approvals.servers[s.identity]).length,
    drifted: servers.filter((s) => approvals.servers[s.identity]?.drift).length,
  };
}

/* ---------------------------------------------------------------- pin / scan */

const clip = (s: string, n = 300) => sanitize(s.length > n ? `${s.slice(0, n)}…` : s);

export function formatDiff(d: ToolDiff): string[] {
  const out: string[] = [];
  for (const c of d.changed) {
    out.push(`  CHANGED  ${c.name}  (${c.fields.join(", ")})`);
    if (c.fields.includes("description")) {
      out.push(`     description before: ${clip(c.before.description) || "(empty)"}`);
      out.push(`     description after:  ${clip(c.after.description) || "(empty)"}`);
    }
    if (c.fields.includes("schema")) {
      out.push(`     parameters before: ${clip(c.before.schema)}`);
      out.push(`     parameters after:  ${clip(c.after.schema)}`);
    }
  }
  for (const n of d.added) out.push(`  ADDED    ${n}  (a tool that was not approved)`);
  for (const n of d.removed) out.push(`  REMOVED  ${n}`);
  return out;
}

type Connected = { ok: true; tools: McpTool[] } | { ok: false; error: string };

/** Start/connect to a server, but only if the user already allowlisted it. */
async function connect(s: ConfiguredServer, policy: McpPolicy, o: McpCmdOptions): Promise<Connected> {
  if (!matchAllow(policy, s.def)) return { ok: false, error: "not on the allowlist, so Cephalo will not start or contact it. Approve it first: cephalo mcp allow " + s.name };
  try {
    const r = await (o.list ?? listTools)(s.def, { timeoutMs: o.timeoutMs ?? 20000 });
    return { ok: true, tools: r.tools };
  } catch (e) {
    return { ok: false, error: sanitize((e as Error).message) };
  }
}

/** Distinct servers (by identity) matching a name, or all of them. */
function pick(name: string | undefined, o: McpCmdOptions): ConfiguredServer[] {
  const all = listAllServers(o).filter((s) => !name || s.name === name);
  const seen = new Set<string>();
  return all.filter((s) => (seen.has(s.identity) ? false : (seen.add(s.identity), true)));
}

export interface PinResult {
  lines: string[];
  exitCode: number;
  /** Set when the caller still has to ask the user before anything is written. */
  apply?: () => string[];
}

/**
 * `cephalo mcp pin <name>` / `approve <name>`: connect, show the tools (or what changed since the last approval),
 * and return `apply` so the CLI can confirm before writing.
 */
export async function planPin(name: string | undefined, o: McpCmdOptions = {}): Promise<PinResult> {
  if (!name) return { lines: ["Usage: cephalo mcp pin <server-name>   [--yes]"], exitCode: 1 };
  const found = pick(name, o);
  if (found.length === 0) return { lines: [`No configured MCP server named "${name}". See: cephalo mcp list`], exitCode: 1 };
  if (found.length > 1) return { lines: [`"${name}" is defined more than once with different commands/URLs; pin it from a directory where only one applies:`, ...found.map((s) => `  ${s.source}: ${s.identity}`)], exitCode: 1 };
  const s = found[0];
  const policy = loadMcpPolicy(o.policyFile ?? mcpPolicyPath());
  const lines = [`Server: ${s.identity}`];
  const conn = await connect(s, policy, o);
  if (!conn.ok) return { lines: [...lines, `Could not read its tools: ${conn.error}`], exitCode: 1 };
  const file = o.approvalsFile ?? approvalStorePath();
  const existing = loadApprovals(file).servers[s.identity];
  let changes = true;
  if (!existing) {
    lines.push(`${conn.tools.length} tool(s) reported. Approving this exact set:`);
    for (const t of conn.tools) lines.push(`  ${pad(t.name, 28)} ${short(fingerprintTool(t))}  ${clip(t.description ?? "", 90)}`);
  } else {
    const d = diffTools(existing.tools, conn.tools);
    if (diffIsEmpty(d)) {
      lines.push(`Nothing changed since ${existing.approvedAt}: ${conn.tools.length} tool(s), fingerprint ${short(existing.fingerprint)}.`);
      changes = false;
    } else {
      lines.push(`Changed since the last approval (${existing.approvedAt}, fingerprint ${short(existing.fingerprint)}):`, ...formatDiff(d));
    }
  }
  if (!changes && !existing?.drift) return { lines, exitCode: 0 };
  return {
    lines,
    exitCode: 0,
    apply: () => {
      const r = pinServer(s.identity, conn.tools, s.name, file);
      clearDrift(s.identity, file);
      return [`Approved ${conn.tools.length} tool(s) for this server. Fingerprint ${short(r.fingerprint)}.`, ...(r.backup ? [`Backup: ${r.backup}`] : [])];
    },
  };
}

export type ScanState = "ok" | "drift" | "unpinned" | "error";
export interface ScanEntry {
  name: string;
  identity: string;
  state: ScanState;
  detail?: string;
  diff?: ToolDiff;
  tools?: number;
  fingerprint?: string;
}

/**
 * `cephalo mcp scan [name]`: re-read every allowlisted server's tool list and compare with what was approved.
 * Changes are flagged in the approvals file, which makes the hook block the changed tools until re-approval.
 * Exit code: 0 clean, 1 some server could not be read, 2 drift found.
 */
export async function runScan(name: string | undefined, o: McpCmdOptions = {}): Promise<{ lines: string[]; exitCode: number; results: ScanEntry[] }> {
  const servers = pick(name, o);
  if (name && servers.length === 0) return { lines: [`No configured MCP server named "${name}". See: cephalo mcp list`], exitCode: 1, results: [] };
  const policy = loadMcpPolicy(o.policyFile ?? mcpPolicyPath());
  const file = o.approvalsFile ?? approvalStorePath();
  const store = loadApprovals(file);
  const results: ScanEntry[] = [];
  const lines: string[] = [];
  const targets = name ? servers : servers.filter((s) => matchAllow(policy, s.def));
  for (const s of targets) {
    const conn = await connect(s, policy, o);
    const pin = store.servers[s.identity];
    if (!conn.ok) {
      results.push({ name: s.name, identity: s.identity, state: "error", detail: conn.error });
      continue;
    }
    const fingerprint = fingerprintServer(conn.tools);
    if (!pin) {
      results.push({ name: s.name, identity: s.identity, state: "unpinned", tools: conn.tools.length, fingerprint, detail: `${conn.tools.length} tool(s), never approved. Run: cephalo mcp pin ${s.name}` });
      continue;
    }
    const diff = diffTools(pin.tools, conn.tools);
    if (diffIsEmpty(diff)) {
      if (pin.drift) clearDrift(s.identity, file);
      results.push({ name: s.name, identity: s.identity, state: "ok", tools: conn.tools.length, fingerprint, detail: `${conn.tools.length} tool(s) match the approved fingerprint ${short(pin.fingerprint)}` });
    } else {
      flagDrift(s.identity, diff, file);
      results.push({ name: s.name, identity: s.identity, state: "drift", diff, tools: conn.tools.length, fingerprint, detail: `fingerprint ${short(pin.fingerprint)} -> ${short(fingerprint)}` });
    }
  }
  if (results.length === 0) lines.push(servers.length ? "No allowlisted MCP servers to scan. Approve one with: cephalo mcp allow <name>" : "No MCP servers are configured.");
  for (const r of results) {
    const tag = { ok: "OK      ", drift: "CHANGED ", unpinned: "UNPINNED", error: "ERROR   " }[r.state];
    lines.push(`${tag} ${r.name}  ${r.identity}`);
    lines.push(`         ${r.detail ?? ""}`);
    if (r.diff) {
      lines.push(...formatDiff(r.diff).map((l) => `  ${l}`));
      lines.push(`         These tools are now blocked in enforce mode until you review and re-approve: cephalo mcp approve ${r.name}`);
    }
  }
  const exitCode = results.some((r) => r.state === "drift") ? 2 : results.some((r) => r.state === "error") ? 1 : 0;
  return { lines, exitCode, results };
}

/* ---------------------------------------------------------------- wrap (print-only) */

/**
 * `cephalo mcp wrap <name>`: show how to put a configured stdio server behind the runtime proxy.
 * Prints the replacement config entry; it never edits an agent's config.
 */
export function planWrap(name: string | undefined, cliJs: string, o: McpCmdOptions = {}): { lines: string[]; exitCode: number } {
  if (!name) return { lines: ["Usage: cephalo mcp wrap <server-name>"], exitCode: 1 };
  const found = listAllServers(o).filter((s) => s.name === name);
  if (found.length === 0) return { lines: [`No configured MCP server named "${name}". See: cephalo mcp list`], exitCode: 1 };
  const s = found[0];
  if (s.def.kind !== "stdio") return { lines: [`"${name}" is a remote (URL) server. The runtime proxy wraps local stdio servers only; remote servers are covered by the allowlist, \`cephalo mcp scan\` and the hook.`], exitCode: 1 };
  const alreadyWrapped = /\bmcp\s+proxy\b/.test([s.def.command, ...(s.def.args ?? [])].join(" "));
  if (alreadyWrapped) return { lines: [`"${name}" already runs behind the proxy.`], exitCode: 0 };
  const args = ["mcp", "proxy", "--name", name, "--", s.def.command!, ...(s.def.args ?? [])];
  const forClaude = { command: "node", args: [cliJs, ...args] };
  const lines = [
    `"${name}" currently runs: ${s.identity.replace(/^cmd:/, "")}   (${s.source}, ${s.origin})`,
    "",
    "Replace its \"command\" and \"args\" with the following (keep your \"env\" as it is). Cephalo does not edit agent configs.",
    "",
    "Claude Code (JSON, in the same place the server is defined today):",
    `  "command": ${JSON.stringify(forClaude.command)},`,
    `  "args": ${JSON.stringify(forClaude.args)}`,
    "",
    "Hermes (YAML, under mcp_servers):",
    `  command: ${JSON.stringify(forClaude.command)}`,
    `  args: ${JSON.stringify(forClaude.args)}`,
    "",
    "The server's identity stays the same (the proxy is unwrapped when matching), so your allowlist entry and pinned tools keep working.",
    "Restart the agent afterwards.",
  ];
  return { lines, exitCode: 0 };
}

export { snapshotTool };

export { identityOf };
