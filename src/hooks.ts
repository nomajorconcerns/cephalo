import { appendAudit, type AuditEntry } from "./audit.js";
import { evaluate, type EvalInput } from "./engine.js";
import { loadRules, type Rule } from "./rules.js";

export type Agent = "claude" | "hermes";

export function blockMessage(rule: Rule): string {
  return `🛑 Cephalo blocked this (rule: ${rule.id} - ${rule.description}). If it is intended, ask the user to run it themselves.`;
}

interface Extracted extends EvalInput {
  tool: string;
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
      return { tool, path: str(ti.file_path), access: "write" };
    default:
      return null;
  }
}

function extractHermes(p: any): Extracted | null {
  const tool = str(p?.tool_name) ?? "unknown";
  const ti = p?.tool_input ?? {};
  switch (tool) {
    case "terminal":
      return { tool, command: str(ti.command) };
    case "read_file":
      return { tool, path: str(ti.path), access: "read" };
    case "write_file":
    case "patch":
      return { tool, path: str(ti.path), access: "write" };
    default:
      return null;
  }
}

export interface HookOptions {
  rules?: Rule[];
  auditFile?: string;
}

/** Process raw stdin JSON for an agent hook. Returns the text to print on stdout. Never throws (fail-open). */
export function runHook(agent: Agent, raw: string, opts: HookOptions = {}): string {
  const allowOut = agent === "claude" ? "" : "{}";
  const log = (e: Omit<AuditEntry, "ts" | "agent">) => {
    try {
      appendAudit({ ts: new Date().toISOString(), agent, ...e }, opts.auditFile);
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
    const res = evaluate(ex, opts.rules ?? loadRules());
    log({
      tool,
      ...(ex.command !== undefined ? { command: ex.command } : {}),
      ...(ex.path !== undefined ? { path: ex.path } : {}),
      decision: res.decision,
      ...(res.rule ? { rule: res.rule.id } : {}),
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
