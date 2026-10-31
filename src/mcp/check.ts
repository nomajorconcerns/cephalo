import { loadMcpPolicy, matchAllow, type McpPolicy } from "./policy.js";
import {
  candidatesFor,
  listClaudeServers,
  listHermesServers,
  parseMcpToolName,
  type ConfiguredServer,
  type ServerLookup,
} from "./servers.js";
import type { Rule } from "../rules.js";

export interface McpCheckOptions extends ServerLookup {
  policy?: McpPolicy;
  /** Test hook: use these servers instead of reading the agent configs. */
  servers?: ConfiguredServer[];
}

export interface McpVerdict {
  decision: "allow" | "block";
  rule?: Rule;
  /** What we learned, for the audit log. */
  server: string;
  mcpTool: string;
  identity?: string;
  /** True when the server's command/URL was found and checked against the allowlist. */
  verified: boolean;
  allowedBy?: string;
  note?: string;
}

const rule = (id: string, description: string): Rule => ({ id, description, type: "command", pattern: "", action: "block" });

/**
 * Decide whether an MCP tool call may proceed. The server is identified by its configured command
 * or URL (looked up from the agent's own config), never by its name.
 */
export function checkMcpCall(agent: "claude" | "hermes", toolName: string, o: McpCheckOptions = {}): McpVerdict | null {
  const servers = o.servers ?? (agent === "claude" ? listClaudeServers(o) : listHermesServers(o));
  const parsed = parseMcpToolName(toolName, servers.map((s) => s.name));
  if (!parsed) return null;
  const policy = o.policy ?? loadMcpPolicy();
  const enforce = policy.mode === "enforce";
  const base = { server: parsed.server, mcpTool: parsed.tool };

  const cands = parsed.plugin ? [] : candidatesFor(parsed, servers);
  if (cands.length === 0) {
    const why = parsed.plugin
      ? "plugin-bundled MCP servers have no command/URL Cephalo can read"
      : `no MCP server matching "${parsed.server}" is configured, so its command/URL cannot be checked`;
    return enforce
      ? { ...base, decision: "block", rule: rule("mcp-unverifiable", `MCP server cannot be verified: ${why}`), verified: false, note: why }
      : { ...base, decision: "allow", verified: false, note: why };
  }

  const missing = cands.filter((c) => !matchAllow(policy, c.def));
  const shown = cands.map((c) => c.identity).join(" ; ");
  if (missing.length === 0) {
    const entry = matchAllow(policy, cands[0].def);
    return { ...base, decision: "allow", identity: shown, verified: true, allowedBy: entry?.command ?? entry?.url };
  }
  if (!enforce) {
    return { ...base, decision: "allow", identity: shown, verified: false, note: "not on the allowlist (audit mode: allowed and logged)" };
  }
  return {
    ...base,
    decision: "block",
    identity: missing.map((c) => c.identity).join(" ; "),
    verified: false,
    rule: rule("mcp-not-allowed", `MCP server is not on the allowlist (${missing[0].identity}). Ask the user to review it with: cephalo mcp list`),
  };
}
