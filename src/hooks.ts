import { currentUser } from "./user.js";
import { isOwnWrite, toolResponseText, tripwireGate, tripwireObserve, type TripHookOptions } from "./tripwire/hook.js";
import { findLeaks } from "./vault/patterns.js";
import { appendAudit, type AuditEntry } from "./audit.js";
import { checkMcpCall, type McpCheckOptions } from "./mcp/check.js";
import { isMcpToolName } from "./mcp/servers.js";
import { redactParams } from "./redact.js";
import { evaluate, type EvalInput } from "./engine.js";
import { loadEffectiveRules, type Rule } from "./rules.js";
import type { Judgement } from "./judge/decide.js";
import type { JudgeMode } from "./models/config.js";

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

/** The shell command (or script text) of a before-call hook payload, for the local-model judge. Null for anything else. */
export function judgeTarget(agent: Agent, raw: string): { command: string; cwd?: string } | null {
  try {
    const payload = JSON.parse(raw);
    const ev = str(payload?.hook_event_name);
    if (ev === "PostToolUse" || ev === "post_tool_call") return null;
    const ex = agent === "claude" ? extractClaude(payload) : extractHermes(payload);
    if (!ex || ex.mcp || ex.command === undefined) return null;
    return { command: ex.command, cwd: str(payload?.cwd) };
  } catch {
    return null;
  }
}

export interface HookOptions {
  /** What the local-model judge said about this call's command (computed before the hook runs; see judge/hook.ts). */
  judge?: { command: string; judgement: Judgement; mode: JudgeMode };
  rules?: Rule[];
  auditFile?: string;
  /** Overrides for MCP checks (tests): policy, home dir, cwd, Hermes config path, or a fixed server list. */
  mcp?: McpCheckOptions;
  /** Overrides for the prompt-injection tripwire (tests): state directory, policy. */
  tripwire?: TripHookOptions;
}

/** Process raw stdin JSON for an agent hook. Returns the text to print on stdout. Never throws (fail-open). */
export function runHook(agent: Agent, raw: string, opts: HookOptions = {}): string {
  const allowOut = agent === "claude" ? "" : "{}";
  let where: { session?: string; cwd?: string } = {};
  const log = (e: Omit<AuditEntry, "ts" | "agent">) => {
    try {
      appendAudit({ ts: new Date().toISOString(), agent, user: currentUser(), ...where, ...e }, opts.auditFile);
    } catch (err) {
      process.stderr.write(`cephalo: audit log failed: ${(err as Error).message}\n`);
    }
  };
  let tool = "unknown";
  try {
    const payload = JSON.parse(raw);
    where = {
      ...(str(payload?.session_id) ? { session: str(payload.session_id) } : {}),
      ...(str(payload?.cwd) ? { cwd: str(payload.cwd) } : {}),
    };
    const evName = str(payload?.hook_event_name);
    if (evName === "PostToolUse" || evName === "post_tool_call") {
      // After the tool ran: look at what came back for prompt injection. Never blocks (the tool has already run).
      const obs = tripwireObserve(agent, payload, opts.tripwire);
      const input = payload?.tool_input ?? {};
      const what = {
        ...(str(input.command) !== undefined ? { command: str(input.command) } : {}),
        ...(str(input.file_path ?? input.path) !== undefined ? { path: str(input.file_path ?? input.path) } : {}),
      };
      const warnings: string[] = [];
      if (obs.event) {
        log({
          tool: obs.tool,
          ...what,
          decision: "allow",
          rule: `tripwire-${obs.event.level}`,
          note: `possible prompt injection in the output of ${obs.tool}: ${obs.event.findings.map((f) => `${f.id} "${f.excerpt}"`).join("; ")}`.slice(0, 600),
        });
        if (obs.warning) warnings.push(obs.warning);
      }
      // A credential in the output is now in the agent's context; log it (type and first characters only) and say so.
      const ownVault = /(^|[\s;&|])((cephalo(\.cmd|\.ps1)?)|(node\s+\S*cephalo\S*[\\/]dist[\\/]cli\.js))\s+vault\s/i.test(`${str(input.command) ?? ""} `);
      if (!isOwnWrite(obs.tool) && !ownVault) {
        const leaks = findLeaks(toolResponseText(agent, payload));
        if (leaks.length) {
          log({ tool: obs.tool, ...what, decision: "allow", rule: "secret-in-output", note: `credential in the output of ${obs.tool}: ${leaks.map((l) => `${l.type} ${l.preview}`).join("; ")}` });
          warnings.push(`Cephalo: the output of ${obs.tool} contains what looks like a credential (${leaks.map((l) => l.type).join(", ")}). Do not repeat or store it. Tell the user it was exposed so they can rotate it. To use a token, ask the user to add it with "cephalo vault set NAME" and run commands with "cephalo run --env NAME -- ...".`);
        }
      }
      if (agent === "claude" && warnings.length) {
        return JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: warnings.join("\n") } });
      }
      return allowOut;
    }
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
    let tripMessage: string | undefined;
    if (res.decision === "allow") {
      const gate = tripwireGate(agent, payload, { tool, command: ex.command, path: ex.path, access: ex.access, mcp: !!ex.mcp }, opts.tripwire);
      if (gate.blocked) {
        res = { decision: "block", rule: gate.blocked.rule };
        tripMessage = gate.blocked.message;
      } else if (gate.note) {
        mcpLog = { ...mcpLog, note: [mcpLog.note, gate.note].filter(Boolean).join("; ") };
      }
    }
    // The local-model judge can only add a block (and only in enforce mode); it never lifts one.
    const j = opts.judge;
    if (res.decision === "allow" && j && ex.command === j.command && j.judgement.verdict !== "allow") {
      const jj = j.judgement;
      const note = `local model ${jj.model}${jj.cached ? " (cached)" : ""}: ${jj.verdict}${jj.reason ? ` - ${jj.reason}` : ""} [${jj.signals.join(", ")}]`;
      if (jj.verdict === "block" && j.mode === "enforce") {
        res = { decision: "block", rule: { id: "judge-decider", description: `a local model judged this harmful: ${jj.reason || "no reason given"}`, type: "command", pattern: "", action: "block" } };
        mcpLog = { ...mcpLog, note };
      } else {
        mcpLog = { ...mcpLog, note: [mcpLog.note, jj.verdict === "block" ? `would block in enforce mode - ${note}` : note].filter(Boolean).join("; ") };
      }
    } else if (res.decision === "allow" && j && ex.command === j.command) {
      mcpLog = { ...mcpLog, note: [mcpLog.note, `local model ${j.judgement.model}${j.judgement.cached ? " (cached)" : ""}: allow [${j.judgement.signals.join(", ")}]`].filter(Boolean).join("; ") };
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
      const message = tripMessage ?? blockMessage(res.rule);
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
