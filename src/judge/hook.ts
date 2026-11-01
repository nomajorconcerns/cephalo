import path from "node:path";
import { appendAudit, type AuditEntry } from "../audit.js";
import { evaluate } from "../engine.js";
import { judgeTarget, runHook, type Agent, type HookOptions } from "../hooks.js";
import { loadEffectiveRules } from "../rules.js";
import { currentUser } from "../user.js";
import { loadModelsConfig, type ModelsConfig } from "../models/config.js";
import type { FetchLike } from "../models/ollama.js";
import { scannableText } from "../tripwire/hook.js";
import { assessText } from "./assess.js";
import { judgeOutcome } from "./decide.js";
import type { JudgeInput } from "./apply.js";
import { checkModelsIfStale, recordAsk, sweepAsks, takeAsk } from "./state.js";

export interface JudgedHookOptions extends HookOptions {
  models?: ModelsConfig;
  fetch?: FetchLike;
  cacheFile?: string;
  embedCacheFile?: string;
  /** Where the model-availability check and pending asks are kept (tests). Default: ~/.cephalo. */
  stateDir?: string;
}

function parseEvent(raw: string): { after: boolean; session?: string; cwd?: string; command?: string } {
  try {
    const p = JSON.parse(raw);
    const ev = p?.hook_event_name;
    return {
      after: ev === "PostToolUse" || ev === "post_tool_call" || ev === "postToolUse",
      ...(typeof p?.session_id === "string" ? { session: p.session_id } : {}),
      ...(typeof p?.cwd === "string" ? { cwd: p.cwd } : {}),
      ...(typeof p?.tool_input?.command === "string" ? { command: p.tool_input.command } : {}),
    };
  } catch {
    return { after: false };
  }
}

/**
 * The hook entry point. Same output as runHook, plus the local-model judge when it is switched on:
 *  - a model check every few minutes (missing models and an unreachable Ollama are logged),
 *  - before a call: a command that shows a risk signal and that the rules allow is put to the decider; the
 *    answer (or the fact that nobody could answer) is passed to runHook, which can only make the outcome
 *    stricter (block, or have the user approve it),
 *  - after a call: the tripwire assist (embedding + reviewer), and the note that the user approved an ask.
 * With the judge off, this is exactly runHook.
 */
export async function runHookJudged(agent: Agent, raw: string, opts: JudgedHookOptions = {}): Promise<string> {
  const { models, fetch, cacheFile, embedCacheFile, stateDir, ...hookOpts } = opts;
  const asksDir = stateDir ? path.join(stateDir, "asks") : undefined;
  const checkFile = stateDir ? path.join(stateDir, "models-check.json") : undefined;
  const log = (e: Omit<AuditEntry, "ts" | "agent">) => {
    try {
      appendAudit({ ts: new Date().toISOString(), agent, user: currentUser(), ...e }, hookOpts.auditFile);
    } catch (err) {
      process.stderr.write(`cephalo: audit log failed: ${(err as Error).message}\n`);
    }
  };
  let config: ModelsConfig;
  try {
    config = models ?? loadModelsConfig(undefined, () => {});
  } catch {
    return runHook(agent, raw, hookOpts);
  }
  if (!config.enabled) return runHook(agent, raw, hookOpts);

  const ev = parseEvent(raw);
  try {
    // Startup check, at most every 10 minutes: say so when a configured model is missing or Ollama is not running.
    const check = await checkModelsIfStale(config, { file: checkFile, fetch });
    if (check && !check.reachable) log({ tool: "models-check", decision: "allow", rule: "models-unreachable", note: `Ollama at ${check.host} is not reachable (${check.error ?? "no answer"}); the local-model judge cannot answer until it runs` });
    else if (check && check.missing.length) log({ tool: "models-check", decision: "allow", rule: "models-missing", note: `configured models not installed in Ollama: ${check.missing.join(", ")} (cephalo models pull)` });
  } catch {
    /* the check is a courtesy */
  }

  if (ev.after) {
    let out: string | undefined;
    try {
      if (config.tripwireAssist) {
        // After the tool ran: let the embedding and reviewer models look at what came back. They can only raise the tripwire's level.
        const payload = JSON.parse(raw);
        const text = scannableText(agent === "hermes" ? "hermes" : "claude", payload, hookOpts.tripwire);
        if (text !== null) {
          const a = await assessText(text, String(payload?.tool_name ?? "tool"), { config, fetch, cacheFile, embedCacheFile });
          if (a.assessment) out = runHook(agent, raw, { ...hookOpts, assessment: a.assessment });
        }
      }
      // The tool ran. If the user had been asked about this exact command, they approved it.
      if (ev.command !== undefined && takeAsk({ command: ev.command, session: ev.session }, asksDir)) {
        log({ tool: String(JSON.parse(raw)?.tool_name ?? "tool"), command: ev.command, decision: "allow", rule: "judge-ask-approved", note: "the user approved this command after Cephalo asked", ...(ev.session ? { session: ev.session } : {}), ...(ev.cwd ? { cwd: ev.cwd } : {}) });
      }
    } catch (e) {
      process.stderr.write(`cephalo: local-model judge skipped: ${(e as Error).message}\n`);
    }
    return out ?? runHook(agent, raw, hookOpts);
  }

  // Before a call.
  try {
    for (const stale of sweepAsks(asksDir)) {
      log({ tool: "ask", command: stale.command, decision: "allow", rule: "judge-ask-unanswered", note: "Cephalo asked the user about this command and it never ran (declined, or still waiting)", ...(stale.session ? { session: stale.session } : {}) });
    }
    const target = judgeTarget(agent, raw);
    if (target) {
      const rules = hookOpts.rules ?? loadEffectiveRules();
      if (evaluate({ command: target.command }, rules).decision === "allow") {
        const r = await judgeOutcome(target.command, { config, fetch, cacheFile, cwd: target.cwd });
        if (r.kind !== "skipped") {
          const judge: JudgeInput = {
            command: target.command,
            mode: config.mode,
            onUnsure: config.onUnsure,
            onFailure: config.onFailure,
            ...(r.kind === "answer" ? { judgement: r.judgement } : { failed: { tried: r.tried, ms: r.ms } }),
          };
          return runHook(agent, raw, { ...hookOpts, rules, judge, onAsk: (a) => recordAsk(a, asksDir) });
        }
      }
    }
  } catch (e) {
    process.stderr.write(`cephalo: local-model judge skipped: ${(e as Error).message}\n`);
  }
  return runHook(agent, raw, hookOpts);
}
