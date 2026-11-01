import type { ModelEvent } from "../audit.js";
import type { JudgeMode } from "../models/config.js";
import type { Rule } from "../rules.js";
import type { Judgement } from "./decide.js";

/** What the local-model judge found out about one command, handed to the hook (see judge/hook.ts). */
export interface JudgeInput {
  command: string;
  mode: JudgeMode;
  onUnsure: "ask" | "allow";
  onFailure: "ask" | "allow";
  /** Set when a model answered. */
  judgement?: Judgement;
  /** Set when the models were asked and none could answer. */
  failed?: { tried: string[]; ms: number };
}

export interface JudgeEffect {
  /** Block the call with this rule. */
  block?: Rule;
  /** Have the user approve it first (Claude Code); the text is what they are shown. */
  ask?: string;
  /** Goes in the audit entry's note. */
  note: string;
  model: ModelEvent;
}

const judgeRule = (id: string, description: string): Rule => ({ id, description, type: "command", pattern: "", action: "block" });

/**
 * Turn the judge's finding into an effect on the call. Only ever makes the outcome stricter, and only in enforce mode:
 *   a confident "block"            -> block
 *   "unsure"                       -> ask (on_unsure)
 *   no model could answer          -> ask (on_failure)      [fail closed]
 *   "allow"                        -> nothing
 * Hermes cannot ask, so for it an "ask" becomes "let it run and log it". In warn mode everything is only logged.
 */
export function applyJudge(agent: "claude" | "hermes", j: JudgeInput): JudgeEffect {
  const enforce = j.mode === "enforce";
  const canAsk = agent === "claude";
  const askOrLog = (wanted: boolean, text: string, why: string): Pick<JudgeEffect, "ask" | "note"> => {
    if (!enforce) return { note: `would ask in enforce mode - ${why}` };
    if (!wanted) return { note: why };
    return canAsk ? { ask: text, note: `asked the user - ${why}` } : { note: `Hermes cannot ask, so it was allowed and logged - ${why}` };
  };

  if (!j.judgement) {
    const tried = (j.failed?.tried ?? []).join("+") || "decider";
    const why = `no local model could judge this command (tried ${tried})`;
    return {
      ...askOrLog(j.onFailure === "ask", `Cephalo could not get an answer from its local model (${tried}), so it cannot tell whether this command is safe. Check it before you approve it.`, why),
      model: { role: "decider", name: tried, verdict: "no-answer", ms: j.failed?.ms ?? 0, cached: false },
    };
  }

  const jj = j.judgement;
  const detail = `local model ${jj.model}${jj.cached ? " (cached)" : ""}: ${jj.verdict}${jj.reason ? ` - ${jj.reason}` : ""} [${jj.signals.join(", ")}]`;
  const model: ModelEvent = { role: "decider", name: jj.model, verdict: jj.verdict, ...(typeof jj.p === "number" ? { p: jj.p } : {}), ms: jj.ms, cached: jj.cached, signals: jj.signals };
  if (jj.verdict === "allow") return { note: detail, model };
  if (jj.verdict === "block") {
    return enforce
      ? { block: judgeRule("judge-decider", `a local model judged this harmful: ${jj.reason || "no reason given"}`), note: detail, model }
      : { note: `would block in enforce mode - ${detail}`, model };
  }
  return {
    ...askOrLog(j.onUnsure === "ask", `Cephalo's local model is not sure about this command (${jj.reason || "unsure"}; looked at: ${jj.signals.join(", ")}). Check it before you approve it.`, detail),
    model,
  };
}
