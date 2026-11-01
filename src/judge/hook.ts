import { evaluate } from "../engine.js";
import { judgeTarget, runHook, type Agent, type HookOptions } from "../hooks.js";
import { loadEffectiveRules } from "../rules.js";
import { loadModelsConfig, type ModelsConfig } from "../models/config.js";
import type { FetchLike } from "../models/ollama.js";
import { judgeCommand } from "./decide.js";

export interface JudgedHookOptions extends HookOptions {
  models?: ModelsConfig;
  fetch?: FetchLike;
  cacheFile?: string;
}

/**
 * The hook entry point. Same output as runHook, but when the local-model judge is on and
 * the command has a risk signal, the decider model is asked first and its answer is passed in.
 * The model is never asked about a call the rules already block. Any failure means no opinion.
 */
export async function runHookJudged(agent: Agent, raw: string, opts: JudgedHookOptions = {}): Promise<string> {
  const { models, fetch, cacheFile, ...hookOpts } = opts;
  try {
    const config = models ?? loadModelsConfig(undefined, () => {});
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
