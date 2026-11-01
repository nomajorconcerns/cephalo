import { evaluate } from "../engine.js";
import { judgeTarget, runHook, type Agent, type HookOptions } from "../hooks.js";
import { loadEffectiveRules } from "../rules.js";
import { loadModelsConfig, type ModelsConfig } from "../models/config.js";
import type { FetchLike } from "../models/ollama.js";
import { scannableText } from "../tripwire/hook.js";
import { assessText } from "./assess.js";
import { judgeCommand } from "./decide.js";

export interface JudgedHookOptions extends HookOptions {
  models?: ModelsConfig;
  fetch?: FetchLike;
  cacheFile?: string;
  embedCacheFile?: string;
}

function isAfterCall(raw: string): boolean {
  try {
    const ev = JSON.parse(raw)?.hook_event_name;
    return ev === "PostToolUse" || ev === "post_tool_call";
  } catch {
    return false;
  }
}

/**
 * The hook entry point. Same output as runHook, but when the local-model judge is on and
 * the command has a risk signal, the decider model is asked first and its answer is passed in.
 * The model is never asked about a call the rules already block. Any failure means no opinion.
 */
export async function runHookJudged(agent: Agent, raw: string, opts: JudgedHookOptions = {}): Promise<string> {
  const { models, fetch, cacheFile, embedCacheFile, ...hookOpts } = opts;
  try {
    const config = models ?? loadModelsConfig(undefined, () => {});
    if (config.enabled && config.tripwireAssist && isAfterCall(raw)) {
      // After the tool ran: let the embedding and reviewer models look at what came back. They can only raise the tripwire's level.
      const payload = JSON.parse(raw);
      const text = scannableText(agent, payload, hookOpts.tripwire);
      if (text !== null) {
        const a = await assessText(text, String(payload?.tool_name ?? "tool"), { config, fetch, cacheFile, embedCacheFile });
        if (a.assessment) return runHook(agent, raw, { ...hookOpts, assessment: a.assessment });
      }
      return runHook(agent, raw, hookOpts);
    }
    const target = config.enabled ? judgeTarget(agent, raw) : null;
    if (target) {
      const rules = hookOpts.rules ?? loadEffectiveRules();
      if (evaluate({ command: target.command }, rules).decision === "allow") {
        const judgement = await judgeCommand(target.command, { config, fetch, cacheFile, cwd: target.cwd });
        if (judgement) return runHook(agent, raw, { ...hookOpts, rules, judge: { command: target.command, judgement, mode: config.mode } });
      }
    }
  } catch (e) {
    process.stderr.write(`cephalo: local-model judge skipped: ${(e as Error).message}\n`);
  }
  return runHook(agent, raw, hookOpts);
}
