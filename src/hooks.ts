import os from "node:os";
import { appendAudit, type AuditEntry } from "./audit.js";
import { checkMcpCall, type McpCheckOptions } from "./mcp/check.js";
import { isMcpToolName } from "./mcp/servers.js";
import { redactParams } from "./redact.js";
import { evaluate, type EvalInput } from "./engine.js";
import { loadEffectiveRules, type Rule } from "./rules.js";

export type Agent = "claude" | "hermes";

export function blockMessage(rule: Rule): string {
  return `🛑 Cephalo blocked this (rule: ${rule.id} - ${rule.description}). If it is intended, ask the user to run it themselves.`;
}

interface Extracted extends EvalInput {
  tool: string;
  /** Set for MCP tool calls (`mcp__server__tool`): checked against the MCP allowlist instead of the command/path rules. */
  mcp?: { params: unknown; cwd?: string };
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function extractClaude(p: any): Extracted | null {
  const tool = str(p?.tool_name) ?? "unknown";
  const ti = p?.tool_input ?? {};
  switch (tool) {
    case "Bash":
      return { tool, command: str(ti.command) };
    case "Read":
      return { tool, path: str(ti.file_path), access: "read" };
    case "Write":
    case "Edit":
    case "MultiEdit":
      return { tool, path: str(ti.file_path), access: "write" };
    case "NotebookEdit":
      return { tool, path: str(ti.notebook_path), access: "write" };
    default:
      if (isMcpToolName(tool)) return { tool, mcp: { params: ti, cwd: str(p?.cwd) } };
      return null;
  }
}

function extractHermes(p: any): Extracted | null {
  const tool = str(p?.tool_name) ?? "unknown";
  const ti = p?.tool_input ?? {};
  switch (tool) {
    case "terminal":
      return { tool, command: str(ti.command) };
    case "execute_code":
      // Heuristic: scan the code text with the command rules (catches rm -rf, DROP TABLE, etc. inside scripts)
      return { tool, command: str(ti.code) };
    case "read_file":
    case "search_files":
      return { tool, path: str(ti.path), access: "read" };
    case "write_file":
    case "patch":
      return { tool, path: str(ti.path), access: "write" };
    default:
      if (isMcpToolName(tool)) return { tool, mcp: { params: ti, cwd: str(p?.cwd) } };
      return null;
  }
}

export interface HookOptions {
  rules?: Rule[];
  auditFile?: string;
  /** Overrides for MCP checks (tests): policy, home dir, cwd, Hermes config path, or a fixed server list. */
  mcp?: McpCheckOptions;
}

function currentUser(): string | undefined {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME ?? process.env.USER;
  }
}

/** Process raw stdin JSON for an agent hook. Returns the text to print on stdout. Never throws (fail-open). */
export function runHook(agent: Agent, raw: string, opts: HookOptions = {}): string {
  const allowOut = agent === "claude" ? "" : "{}";
  const log = (e: Omit<AuditEntry, "ts" | "agent">) => {
    try {
      appendAudit({ ts: new Date().toISOString(), agent, user: currentUser(), ...e }, opts.auditFile);
    } catch (err) {
      process.stderr.write(`cephalo: audit log failed: ${(err as Error).message}\n`);
    }
  };
  let tool = "unknown";
  try {
    const payload = JSON.parse(raw);
    const ex = agent === "claude" ? extractClaude(payload) : extractHermes(payload);
    if (!ex) {
      log({ tool: str(payload?.tool_name) ?? "unknown", decision: "allow" });
      return allowOut;
    }
    tool = ex.tool;
    let res: { decision: "allow" | "block"; rule?: Rule };
    let mcpLog: Partial<AuditEntry> = {};
    if (ex.mcp) {
      const v = checkMcpCall(agent, tool, { cwd: ex.mcp.cwd, ...opts.mcp });
      res = v ? { decision: v.decision, rule: v.rule } : { decision: "allow" };
      mcpLog = {
        params: redactParams(ex.mcp.params),
        ...(v ? { server: v.server, ...(v.identity ? { serverId: v.identity } : {}), ...(v.pinnedFingerprint ? { pin: v.pinnedFingerprint.slice(0, 12) } : {}), ...(v.note ? { note: v.note } : {}) } : {}),
      };
    } else {
      res = evaluate(ex, opts.rules ?? loadEffectiveRules());
    }
    log({
      tool,
      ...(ex.command !== undefined ? { command: ex.command } : {}),
      ...(ex.path !== undefined ? { path: ex.path } : {}),
      decision: res.decision,
      ...(res.rule ? { rule: res.rule.id } : {}),
      ...mcpLog,
    });
    if (res.decision === "block" && res.rule) {
      const message = blockMessage(res.rule);
      return agent === "claude"
        ? JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: message,
            },
          })
        : JSON.stringify({ action: "block", message });
    }
    return allowOut;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    process.stderr.write(`cephalo: hook error (allowing call): ${msg}\n`);
    log({ tool, decision: "allow", error: msg });
    return allowOut;
  }
}
