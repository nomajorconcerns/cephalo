import { scanText } from "../tripwire/detect.js";
import type { Assessment } from "../tripwire/hook.js";
import type { ModelsConfig } from "../models/config.js";
import type { FetchLike } from "../models/ollama.js";
import { reviewText, type Review } from "./review.js";
import { semanticScan, type SemanticResult } from "./semantic.js";

export interface AssessOptions {
  config: ModelsConfig;
  fetch?: FetchLike;
  /** judge-cache.json and embed-cache.json (tests). */
  cacheFile?: string;
  embedCacheFile?: string;
}

export interface TextAssessment {
  /** What to add to the tripwire's record, or null when the models add nothing. */
  assessment: Assessment | null;
  /** The regex scan's level for this text. */
  regexLevel: "none" | "watch" | "alert";
  semantic: SemanticResult | null;
  review: Review | null;
}

const modelFinding = (r: Review) => ({ id: "model-review", severity: "high" as const, label: "A local model judged this text a prompt injection", excerpt: `${r.model}: ${r.reason}`.slice(0, 200) });

/**
 * What the local models add to the regex tripwire for one piece of tool output.
 *   regex alert  -> nothing to add (already at the top level)
 *   regex watch  -> the reviewer reads it; "injection" raises it to alert, anything else changes nothing
 *   regex clean  -> the embedding model looks for paraphrases of known injections; a match is a watch,
 *                   and the reviewer then decides: "injection" raises it to alert, "benign" drops it
 * A model can only raise the level. A "benign" verdict never lowers or removes a regex finding.
 */
export async function assessText(text: string, source: string, o: AssessOptions): Promise<TextAssessment> {
  const regex = scanText(text);
  const out: TextAssessment = { assessment: null, regexLevel: regex.level, semantic: null, review: null };
  if (regex.level === "alert") return out;

  if (regex.level === "watch") {
    const snippets = regex.findings.map((f) => f.excerpt).filter(Boolean);
    out.review = await reviewText(snippets.length ? snippets : [text.slice(0, 1200)], source, { config: o.config, fetch: o.fetch, cacheFile: o.cacheFile });
    if (out.review?.verdict === "injection") out.assessment = { level: "alert", findings: [modelFinding(out.review)] };
    return out;
  }

  if (!o.config.tripwireAssist) return out;
  out.semantic = await semanticScan(text, { config: o.config, fetch: o.fetch, cacheFile: o.embedCacheFile });
  if (!out.semantic || out.semantic.hits.length === 0) return out;
  const findings = out.semantic.hits.map((h) => ({ id: "semantic-match", severity: "medium" as const, label: `Resembles a known prompt-injection phrasing (similarity ${h.score})`, excerpt: h.excerpt }));
  out.review = await reviewText(out.semantic.hits.map((h) => h.text), source, { config: o.config, fetch: o.fetch, cacheFile: o.cacheFile });
  if (out.review?.verdict === "benign") return out;
  if (out.review?.verdict === "injection") out.assessment = { level: "alert", findings: [...findings, modelFinding(out.review)] };
  else out.assessment = { level: "watch", findings };
  return out;
}
