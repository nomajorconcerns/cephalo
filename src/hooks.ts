import { currentUser } from "./user.js";
import { isOwnWrite, toolResponseText, tripwireAddAssessment, tripwireGate, tripwireObserve, type Assessment, type TripHookOptions } from "./tripwire/hook.js";
import { findLeaks } from "./vault/patterns.js";
import { appendAudit, type AuditEntry } from "./audit.js";
import { checkMcpCall, type McpCheckOptions } from "./mcp/check.js";
import { isMcpToolName } from "./mcp/servers.js";
import { redactParams } from "./redact.js";
import { DEFAULT_CONFIG, type Config } from "./config.js";
import { evaluate, type EvalInput, type EvalResult } from "./engine.js";
import { integrityWarning, sessionStartCheck, type SessionCheckOptions } from "./integrity.js";
import path from "node:path";
import { cephaloDir, loadEffectiveRules, type Rule } from "./rules.js";
import { applyJudge, type JudgeInput } from "./judge/apply.js";
import { checkSearch } from "./search-guard.js";
import { analyzeCommand } from "./analyze.js";
import type { EgressInput, ProRuntime } from "./pro.js";

/** claude and hermes have their own adapters; codex speaks Claude Code's hook format; cursor has its own (flat) answer format. */
export type Agent = "claude" | "hermes" | "codex" | "cursor";

/** The agents whose payloads look like Claude Code's (tool_name, tool_input, tool_response). */
const claudeShaped = (agent: Agent): "claude" | "hermes" => (agent === "hermes" ? "hermes" : "claude");

/** Codex: Claude-style names. MCP calls are not checked (their servers are not in a config Cephalo reads); apply_patch has no path field. */
function extractCodex(p: any): Extracted | null {
  const ex = extractClaude(p);
  return ex && !ex.mcp ? ex : null;
}

/** Cursor: shell is "Shell"; file tools carry a path. MCP calls ("MCP:<tool>") are not checked. */
function extractCursor(p: any): Extracted | null {
  const tool = str(p?.tool_name) ?? "unknown";
  const ti = p?.tool_input ?? {};
  const path = str(ti.file_path) ?? str(ti.path) ?? str(ti.target_file);
  switch (tool) {
    case "Shell":
      return { tool, command: str(ti.command) ?? str(p?.command) };
    case "Read":
      return { tool, path, access: "read" };
    case "Write":
    case "Delete":
      return { tool, path, access: "write" };
    default:
      return null;
  }
}

const extractFor = (agent: Agent, p: any): Extracted | null =>
  agent === "claude" ? extractClaude(p) : agent === "hermes" ? extractHermes(p) : agent === "codex" ? extractCodex(p) : extractCursor(p);

const isAfter = (ev: string | undefined) => ev === "PostToolUse" || ev === "post_tool_call" || ev === "postToolUse";

export function blockMessage(rule: Rule): string {
  return `🛑 Cephalo blocked this (rule: ${rule.id} - ${rule.description}). If it is intended, ask the user to run it themselves.`;
}

interface Extracted extends EvalInput {
  tool: string;
  /** Grep/Glob/search_files: the file filters the call carries, checked for .env (see search-guard.ts). Present means "this is a search". */
  search?: { globs: string[] };
  /** WebFetch/WebSearch/web_search/web_extract: no rule reads them, but a tripwire-locked session loses them. `urls` are what a fetch was asked to reach. */
  web?: { what: string; urls?: string[] };
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
    case "Grep":
      return { tool, path: str(ti.path), access: "read", search: { globs: [str(ti.glob)].filter((g): g is string => !!g) } };
    case "Glob":
      return { tool, path: str(ti.path), access: "read", search: { globs: [str(ti.pattern)].filter((g): g is string => !!g) } };
    case "WebFetch":
      return { tool, web: { what: hostOf(str(ti.url)), urls: [str(ti.url)].filter((u): u is string => !!u) } };
    case "WebSearch":
      return { tool, web: { what: "search" } };
    default:
      if (isMcpToolName(tool)) return { tool, mcp: { params: ti, cwd: str(p?.cwd) } };
      return null;
  }
}

/** Host of a URL for the audit log (never the path or query, which can carry secrets). */
function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).host : "unknown";
  } catch {
    return "unparsable-url";
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
      return { tool, path: str(ti.path), access: "read" };
    case "search_files": {
      // target "files" matches file names with `pattern`; target "content" searches inside files and filters them with `file_glob`.
      const globs = [str(ti.file_glob), str(ti.target) === "files" ? str(ti.pattern) : undefined].filter((g): g is string => !!g);
      return { tool, path: str(ti.path), access: "read", search: { globs } };
    }
    case "write_file":
    case "patch":
      return { tool, path: str(ti.path), access: "write" };
    case "web_search":
      return { tool, web: { what: "search" } };
    case "web_extract":
      return { tool, web: { what: hostOf(Array.isArray(ti.urls) ? str(ti.urls[0]) : str(ti.url)), urls: [...(Array.isArray(ti.urls) ? ti.urls : []), ti.url].filter((u): u is string => typeof u === "string") } };
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
    if (isAfter(ev)) return null;
    const ex = extractFor(agent, payload);
    if (!ex || ex.mcp || ex.command === undefined) return null;
    return { command: ex.command, cwd: str(payload?.cwd) };
  } catch {
    return null;
  }
}

export interface HookOptions {
  /** What the local-model judge said about this call's command (computed before the hook runs; see judge/hook.ts). */
  judge?: JudgeInput;
  /** Called when the user is being asked to approve a call, so a later "it ran" can be recorded as their approval (judge/state.ts). */
  onAsk?: (ask: { command: string; session?: string }) => void;
  /** What the local models found in a tool's output (after-call events; see judge/hook.ts). */
  assessment?: Assessment;
  rules?: Rule[];
  auditFile?: string;
  /** Overrides for MCP checks (tests): policy, home dir, cwd, Hermes config path, or a fixed server list. */
  mcp?: McpCheckOptions;
  /** Overrides for the prompt-injection tripwire (tests): state directory, policy. */
  tripwire?: TripHookOptions;
  /** Settings from config.yml. The CLI passes the real ones; library callers and tests get the defaults. */
  config?: Config;
  /** Run the self-integrity check on the first call of a session. Off unless given (the CLI turns it on). */
  integrity?: SessionCheckOptions;
  /** The paid package, when this machine has a current license for it (see pro.ts). The CLI loads it; library callers and tests get none. */
  pro?: ProRuntime | null;
  /** Where the egress allowlist lives (tests). */
  egressFile?: string;
}

/** What each agent expects back to stop a call. */
export function denyOutput(agent: Agent, message: string): string {
  if (agent === "cursor") return JSON.stringify({ permission: "deny", user_message: message, agent_message: message });
  return agent === "claude" || agent === "codex"
    ? JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: message } })
    : JSON.stringify({ action: "block", message });
}

/** An `ask` rule where the agent cannot show a prompt, and the config says to block. */
export function askBlockedMessage(rule: Rule, agent: string): string {
  return `🛑 Cephalo blocked this (rule: ${rule.id} - ${rule.description}). This rule asks for the user's approval, and ${agent} cannot show an approval prompt, so it was blocked. If it is intended, ask the user to run it themselves.`;
}

/** Add a warning the user will see to a hook's answer. Only Claude Code documents a field for it (systemMessage). */
function withWarning(agent: Agent, out: string, warning: string): string {
  if (agent !== "claude") return out;
  try {
    const j = out ? JSON.parse(out) : {};
    return JSON.stringify({ ...j, systemMessage: warning });
  } catch {
    return out;
  }
}

/** Process raw stdin JSON for an agent hook. Returns the text to print on stdout. Never throws (fail-open, unless fail-closed mode is on). */
export function runHook(agent: Agent, raw: string, opts: HookOptions = {}): string {
  // Claude Code and Codex take empty output as "allow". Hermes and Cursor want JSON (Cursor blocks on anything it cannot parse).
  const allowOut = agent === "claude" || agent === "codex" ? "" : agent === "cursor" ? JSON.stringify({ permission: "allow" }) : "{}";
  const family = claudeShaped(agent);
  const cfg = opts.config ?? DEFAULT_CONFIG;
  let where: { session?: string; cwd?: string } = {};
  const log = (e: Omit<AuditEntry, "ts" | "agent">) => {
    try {
      appendAudit({ ts: new Date().toISOString(), agent, user: currentUser(), ...where, ...e }, opts.auditFile, opts.pro?.audit ? opts.pro.audit.append : undefined);
    } catch (err) {
      process.stderr.write(`cephalo: audit log failed: ${(err as Error).message}\n`);
    }
  };
  let tool = "unknown";
  let afterCall = false;
  let warning: string | undefined;
  const finish = (out: string) => (warning ? withWarning(agent, out, warning) : out);
  try {
    const payload = JSON.parse(raw);
    where = {
      ...(str(payload?.session_id) ? { session: str(payload.session_id) } : {}),
      ...(str(payload?.cwd) ? { cwd: str(payload.cwd) } : {}),
    };
    const evName = str(payload?.hook_event_name);
    if (isAfter(evName)) {
      afterCall = true;
      // After the tool ran: look at what came back for prompt injection. Never blocks (the tool has already run).
      const obs = tripwireObserve(family, payload, opts.tripwire);
      const input = payload?.tool_input ?? {};
      const what = {
        ...(str(input.command) !== undefined ? { command: str(input.command) } : {}),
        ...(str(input.file_path ?? input.path) !== undefined ? { path: str(input.file_path ?? input.path) } : {}),
      };
      const warnings: string[] = [];
      // What the local models added (embedding match, reviewer verdict) is recorded as one more event; it can only raise the level.
      const add = opts.assessment ? tripwireAddAssessment(family, payload, opts.assessment, opts.tripwire) : undefined;
      const event = add?.event ?? obs.event;
      const warning = add?.warning ?? obs.warning;
      if (event) {
        log({
          tool: obs.tool,
          ...what,
          decision: "allow",
          rule: `tripwire-${event.level}`,
          note: `possible prompt injection in the output of ${obs.tool}: ${event.findings.map((f) => `${f.id} "${f.excerpt}"`).join("; ")}`.slice(0, 600),
        });
        if (warning) warnings.push(warning);
      }
      // A credential in the output is now in the agent's context; log it (type and first characters only) and say so.
      const ownVault = /(^|[\s;&|])((cephalo(\.cmd|\.ps1)?)|(node\s+\S*cephalo\S*[\\/]dist[\\/]cli\.js))\s+vault\s/i.test(`${str(input.command) ?? ""} `);
      if (!isOwnWrite(obs.tool) && !ownVault) {
        const leaks = findLeaks(toolResponseText(family, payload));
        if (leaks.length) {
          log({ tool: obs.tool, ...what, decision: "allow", rule: "secret-in-output", note: `credential in the output of ${obs.tool}: ${leaks.map((l) => `${l.type} ${l.preview}`).join("; ")}` });
          warnings.push(`Cephalo: the output of ${obs.tool} contains what looks like a credential (${leaks.map((l) => l.type).join(", ")}). Do not repeat or store it. Tell the user it was exposed so they can rotate it. To use a token, ask the user to add it with "cephalo vault set NAME" and run commands with "cephalo run --env NAME -- ...".`);
        }
      }
      if ((agent === "claude" || agent === "codex") && warnings.length) {
        return JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: warnings.join("\n") } });
      }
      return agent === "cursor" ? "{}" : allowOut;
    }

    // First call of a session: is the guard itself still intact?
    let integrityProblems: string[] = [];
    if (opts.integrity) {
      const chk = sessionStartCheck(agent, payload, opts.integrity);
      integrityProblems = chk.problems;
      if (integrityProblems.length) {
        warning = integrityWarning(integrityProblems);
        if (chk.first) {
          // warn once per session; fail-closed mode keeps blocking for as long as the result is bad
          process.stderr.write(`cephalo: ${warning}\n`);
          log({ tool: "integrity-check", decision: "allow", rule: "integrity-check", note: integrityProblems.join("; ").slice(0, 600) });
        } else if (!cfg.failClosed) warning = undefined;
      }
    }

    const ex = extractFor(agent, payload);
    if (!ex) {
      log({ tool: str(payload?.tool_name) ?? "unknown", decision: "allow" });
      return finish(allowOut);
    }
    tool = ex.tool;
    let res: EvalResult;
    let mcpLog: Partial<AuditEntry> = {};
    if (ex.mcp) {
      const v = checkMcpCall(family, tool, { cwd: ex.mcp.cwd, ...opts.mcp });
      res = v ? { decision: v.decision, rule: v.rule } : { decision: "allow" };
      mcpLog = {
        params: redactParams(ex.mcp.params),
        ...(v ? { server: v.server, ...(v.identity ? { serverId: v.identity } : {}), ...(v.pinnedFingerprint ? { pin: v.pinnedFingerprint.slice(0, 12) } : {}), ...(v.note ? { note: v.note } : {}) } : {}),
      };
    } else {
      const rules = opts.rules ?? loadEffectiveRules();
      res = evaluate({ command: ex.command, path: ex.path, access: ex.access, cwd: where.cwd }, rules, undefined, { shadowAll: cfg.shadow });
      // Grep/Glob/search_files read or list files without a shell: look at what the search is aimed at.
      if (res.decision === "allow" && ex.search) {
        const hit = checkSearch({ path: ex.path, globs: ex.search.globs, cwd: where.cwd });
        if (hit) res = { ...res, decision: "block", rule: hit };
      }
      if (ex.web) mcpLog = { note: `${tool} ${ex.web.what}` };
      if (res.shadow?.length) mcpLog = { ...mcpLog, shadow: res.shadow.map((s) => ({ rule: s.rule.id, would: s.would })) };
    }
    let tripMessage: string | undefined;
    let blockText: string | undefined;
    if (res.decision !== "block") {
      const gate = tripwireGate(family, payload, { tool, command: ex.command, path: ex.path, access: ex.access, mcp: !!ex.mcp }, opts.tripwire);
      // (the web tools carry no command or path; tripwireGate recognises them by tool name)
      if (gate.blocked) {
        res = { decision: "block", rule: gate.blocked.rule };
        tripMessage = gate.blocked.message;
      } else if (gate.note) {
        mcpLog = { ...mcpLog, note: [mcpLog.note, gate.note].filter(Boolean).join("; ") };
      }
    }
    // Paid: where would this call send data? Only a current license plus the Pro package plus the user's own egress.yml switch this on.
    if (opts.pro?.egress && res.decision !== "block") {
      const input: EgressInput = ex.mcp
        ? { params: ex.mcp.params }
        : ex.web
          ? { urls: ex.web.urls ?? [] }
          : ex.command !== undefined
            ? (() => {
                const a = analyzeCommand(ex.command);
                return { commands: [ex.command, ...a.units], unreadable: !a.ok };
              })()
            : {};
      const v = opts.pro.egress.check(input, { file: opts.egressFile ?? path.join(cephaloDir(), "egress.yml") });
      if (v && v.decision !== "allow") {
        res = { decision: v.decision, rule: { id: "egress-allowlist", description: v.reason, type: "command", pattern: "", action: v.decision } };
        mcpLog = { ...mcpLog, note: [mcpLog.note, `egress: ${v.hosts.slice(0, 5).join(", ") || "unknown destination"}`].filter(Boolean).join("; ") };
      }
    }
    // Fail-closed mode: a failed integrity check blocks the call (otherwise it only warns).
    if (cfg.failClosed && integrityProblems.length && res.decision !== "block") {
      res = { decision: "block", rule: { id: "integrity-check", description: "Cephalo's own files or hook entry changed (see cephalo doctor)", type: "command", pattern: "", action: "block" } };
      tripMessage = `🛑 Cephalo blocked this: ${warning}`;
    }
    // A rule that says `ask`: Claude Code shows the user an approval prompt. Agents that cannot ask follow ask_default in config.yml.
    let askText: string | undefined;
    let askRule: Rule | undefined;
    if (res.decision === "ask" && res.rule) {
      if (agent === "claude") {
        askRule = res.rule;
        askText = `Cephalo rule "${res.rule.id}" asks you to approve this: ${res.rule.description}`;
        res = { decision: "allow", ...(res.shadow ? { shadow: res.shadow } : {}) };
      } else if (cfg.askDefault === "block") {
        blockText = askBlockedMessage(res.rule, agent);
        mcpLog = { ...mcpLog, note: [mcpLog.note, "ask → blocked (no prompt available)"].filter(Boolean).join("; ") };
        res = { decision: "block", rule: res.rule, ...(res.shadow ? { shadow: res.shadow } : {}) };
      } else {
        mcpLog = { ...mcpLog, rule: undefined, note: [mcpLog.note, `ask → allowed (no prompt available; rule ${res.rule.id})`].filter(Boolean).join("; ") };
        res = { decision: "allow", ...(res.shadow ? { shadow: res.shadow } : {}) };
      }
    }
    // The local-model judge only ever makes the outcome stricter (block, or ask the user); it never lifts a block.
    const j = opts.judge;
    if (res.decision === "allow" && !askText && j && ex.command === j.command) {
      const eff = applyJudge(agent, j);
      if (eff.block) res = { decision: "block", rule: eff.block };
      askText = eff.ask;
      mcpLog = { ...mcpLog, note: [mcpLog.note, eff.note].filter(Boolean).join("; "), model: eff.model };
    }
    log({
      tool,
      ...(ex.command !== undefined ? { command: ex.command } : {}),
      ...(ex.path !== undefined ? { path: ex.path } : {}),
      decision: askText ? "ask" : res.decision,
      ...(res.rule ? { rule: res.rule.id } : askRule ? { rule: askRule.id } : askText ? { rule: "judge-ask" } : {}),
      ...mcpLog,
    });
    if (askText && res.decision === "allow") {
      opts.onAsk?.({ command: ex.command ?? "", session: where.session });
      return finish(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: askText } }));
    }
    if (res.decision === "block" && res.rule) return finish(denyOutput(agent, tripMessage ?? blockText ?? blockMessage(res.rule)));
    return finish(allowOut);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (cfg.failClosed && !afterCall) {
      // Fail-closed mode: a hook that cannot decide says no.
      process.stderr.write(`cephalo: hook error (fail-closed, blocking call): ${msg}\n`);
      log({ tool, decision: "block", rule: "fail-closed", error: msg });
      return denyOutput(agent, `🛑 Cephalo could not check this call (${msg}) and fail-closed mode is on, so it was blocked. Turn it off with: cephalo config set fail-closed off`);
    }
    process.stderr.write(`cephalo: hook error (allowing call): ${msg}\n`);
    log({ tool, decision: "allow", error: msg });
    return allowOut;
  }
}
