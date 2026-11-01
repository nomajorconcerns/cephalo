import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { cephaloDir } from "../rules.js";

/**
 * Local-model judge configuration (models.yml).
 *
 * Roles say what a model is used for; each role has an ordered list of Ollama
 * tags (first is preferred, the rest are fallbacks).
 *   decider    small, fast: allow/deny on ambiguous actions
 *   reviewer   larger: second opinion on injection suspects and escalations
 *   embedding  vectors for similarity checks
 */
export const ROLES = ["decider", "reviewer", "embedding"] as const;
export type Role = (typeof ROLES)[number];

/** warn: the judge's "block" is logged and the call goes ahead. enforce: the call is blocked. */
export type JudgeMode = "warn" | "enforce";

export interface ModelsConfig {
  enabled: boolean;
  mode: JudgeMode;
  host: string;
  timeoutMs: number;
  /** enforce mode, model unsure about a command: ask the user (Claude Code) or let it run and log it. */
  onUnsure: "ask" | "allow";
  /** enforce mode, no model could answer: ask the user (Claude Code) or let it run and log it. Hermes cannot ask, so it always logs. */
  onFailure: "ask" | "allow";
  /** How long Ollama keeps a model loaded after Cephalo used it (a cold load takes seconds on a CPU). */
  keepAlive: string;
  /** Decision models (like d3) answer with a probability: at or above this it counts as "block"/"injection"... */
  decisionBlock: number;
  /** ...and at or below this as "allow"/"benign". In between is "unsure". */
  decisionAllow: number;
  /** The reviewer reads suspicious text with a bigger model, so it gets its own, longer budget. */
  reviewerTimeoutMs: number;
  /** Cosine similarity at which a piece of tool output counts as resembling a known injection phrasing. */
  similarityThreshold: number;
  /** Use the embedding and reviewer models on what tools return (adds to the prompt-injection tripwire). */
  tripwireAssist: boolean;
  roles: Record<Role, string[]>;
}

export const DEFAULT_MODELS_CONFIG: ModelsConfig = {
  enabled: false,
  mode: "warn",
  host: "http://127.0.0.1:11434",
  timeoutMs: 8000,
  onUnsure: "ask",
  onFailure: "ask",
  keepAlive: "10m",
  decisionBlock: 0.9,
  decisionAllow: 0.3,
  reviewerTimeoutMs: 20000,
  similarityThreshold: 0.72,
  tripwireAssist: true,
  roles: {
    decider: ["d3:2b", "qwen3.5:4b"],
    // Measured on a CPU-only PC: d3:2b judged 8 test texts correctly in ~2.6 s each; qwen3.5:9b also did, but took 15-29 s.
    reviewer: ["d3:2b", "qwen3.5:9b"],
    embedding: ["nomic-embed-text"],
  },
};

export function modelsConfigPath(): string {
  return path.join(cephaloDir(), "models.yml");
}

const cloneDefaults = (): ModelsConfig => ({
  ...DEFAULT_MODELS_CONFIG,
  roles: {
    decider: [...DEFAULT_MODELS_CONFIG.roles.decider],
    reviewer: [...DEFAULT_MODELS_CONFIG.roles.reviewer],
    embedding: [...DEFAULT_MODELS_CONFIG.roles.embedding],
  },
});

/** Cephalo only talks to an Ollama on this machine: commands and file text must not leave it. */
export function isLoopbackHost(host: string): boolean {
  try {
    const h = new URL(host).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
  } catch {
    return false;
  }
}

const TAG = /^[A-Za-z0-9][A-Za-z0-9._\-/]*(:[A-Za-z0-9._\-]+)?$/;

export function parseModelsConfig(text: string): { config: ModelsConfig; problems: string[] } {
  const config = cloneDefaults();
  const problems: string[] = [];
  let doc: any;
  try {
    doc = parse(text) ?? {};
  } catch (e) {
    return { config, problems: [`models.yml is not valid YAML (${(e as Error).message}); using defaults`] };
  }
  if (typeof doc !== "object" || Array.isArray(doc)) return { config, problems: ["models.yml must be a mapping; using defaults"] };

  if (doc.enabled !== undefined) {
    if (typeof doc.enabled === "boolean") config.enabled = doc.enabled;
    else problems.push(`enabled must be true or false (got ${JSON.stringify(doc.enabled)}); using ${config.enabled}`);
  }
  if (doc.mode !== undefined) {
    if (doc.mode === "warn" || doc.mode === "enforce") config.mode = doc.mode;
    else problems.push(`mode must be warn or enforce (got ${JSON.stringify(doc.mode)}); using ${config.mode}`);
  }
  if (doc.host !== undefined) {
    if (typeof doc.host === "string" && isLoopbackHost(doc.host)) config.host = doc.host.replace(/\/+$/, "");
    else problems.push(`host must be a local Ollama address such as ${config.host} (got ${JSON.stringify(doc.host)}); using ${config.host}`);
  }
  if (doc.timeout_ms !== undefined) {
    const n = doc.timeout_ms;
    if (Number.isInteger(n) && n >= 200 && n <= 120000) config.timeoutMs = n;
    else problems.push(`timeout_ms must be a whole number from 200 to 120000 (got ${JSON.stringify(n)}); using ${config.timeoutMs}`);
  }
  for (const [key, field] of [["on_unsure", "onUnsure"], ["on_failure", "onFailure"]] as const) {
    if (doc[key] === undefined) continue;
    if (doc[key] === "ask" || doc[key] === "allow") config[field] = doc[key];
    else problems.push(`${key} must be ask or allow (got ${JSON.stringify(doc[key])}); using ${config[field]}`);
  }
  if (doc.keep_alive !== undefined) {
    if (typeof doc.keep_alive === "string" && /^\d{1,4}[smh]$/.test(doc.keep_alive)) config.keepAlive = doc.keep_alive;
    else problems.push(`keep_alive must look like 10m, 30s or 1h (got ${JSON.stringify(doc.keep_alive)}); using ${config.keepAlive}`);
  }
  for (const [key, field] of [["decision_block", "decisionBlock"], ["decision_allow", "decisionAllow"]] as const) {
    if (doc[key] === undefined) continue;
    const n = doc[key];
    if (typeof n === "number" && n > 0 && n < 1) config[field] = n;
    else problems.push(`${key} must be a number between 0 and 1 (got ${JSON.stringify(n)}); using ${config[field]}`);
  }
  if (config.decisionAllow >= config.decisionBlock) {
    problems.push("decision_allow must be lower than decision_block; using the defaults");
    config.decisionAllow = DEFAULT_MODELS_CONFIG.decisionAllow;
    config.decisionBlock = DEFAULT_MODELS_CONFIG.decisionBlock;
  }
  if (doc.reviewer_timeout_ms !== undefined) {
    const n = doc.reviewer_timeout_ms;
    if (Number.isInteger(n) && n >= 1000 && n <= 120000) config.reviewerTimeoutMs = n;
    else problems.push(`reviewer_timeout_ms must be a whole number from 1000 to 120000 (got ${JSON.stringify(n)}); using ${config.reviewerTimeoutMs}`);
  }
  if (doc.similarity_threshold !== undefined) {
    const n = doc.similarity_threshold;
    if (typeof n === "number" && n >= 0.5 && n <= 0.99) config.similarityThreshold = n;
    else problems.push(`similarity_threshold must be a number from 0.5 to 0.99 (got ${JSON.stringify(n)}); using ${config.similarityThreshold}`);
  }
  if (doc.tripwire_assist !== undefined) {
    if (typeof doc.tripwire_assist === "boolean") config.tripwireAssist = doc.tripwire_assist;
    else problems.push(`tripwire_assist must be true or false (got ${JSON.stringify(doc.tripwire_assist)}); using ${config.tripwireAssist}`);
  }
  if (doc.roles !== undefined) {
    if (typeof doc.roles !== "object" || doc.roles === null || Array.isArray(doc.roles)) {
      problems.push("roles must be a mapping of role -> list of model tags; using defaults");
    } else {
      for (const [role, value] of Object.entries<any>(doc.roles)) {
        if (!(ROLES as readonly string[]).includes(role)) {
          problems.push(`unknown role "${role}" ignored (roles: ${ROLES.join(", ")})`);
          continue;
        }
        const list = typeof value === "string" ? [value] : value;
        if (!Array.isArray(list) || list.length === 0 || !list.every((t) => typeof t === "string" && TAG.test(t))) {
          problems.push(`role ${role} needs one or more Ollama tags like name:size; using the default`);
          continue;
        }
        config.roles[role as Role] = [...new Set<string>(list)];
      }
    }
  }
  return { config, problems };
}

export function loadModelsConfig(file: string = modelsConfigPath(), warn: (m: string) => void = (m) => process.stderr.write(`cephalo: ${m}\n`)): ModelsConfig {
  if (!fs.existsSync(file)) return cloneDefaults();
  try {
    const { config, problems } = parseModelsConfig(fs.readFileSync(file, "utf8"));
    for (const p of problems) warn(p);
    return config;
  } catch {
    return cloneDefaults();
  }
}

export function serializeModelsConfig(c: ModelsConfig): string {
  const list = (r: Role) => c.roles[r].map((t) => `    - ${t}`).join("\n");
  return (
    "# Cephalo local-model judge (Ollama, on this machine only).\n" +
    "# enabled: when false, Cephalo never calls a model.\n" +
    "# roles: ordered Ollama tags per role; the first installed one is used, the rest are fallbacks.\n" +
    "# mode: warn logs what the judge would block and lets the call run; enforce blocks it. The judge can only add blocks, never lift a rule's block.\n" +
    `enabled: ${c.enabled}\n` +
    `mode: ${c.mode}\n` +
    `host: ${c.host}\n` +
    `timeout_ms: ${c.timeoutMs}\n` +
    "# In enforce mode: on_unsure / on_failure say what happens when the model is unsure, or no model could answer.\n" +
    "# ask = Claude Code asks you to approve the command (Hermes cannot ask, so it lets the call run and logs it). allow = let it run and log it.\n" +
    `on_unsure: ${c.onUnsure}\n` +
    `on_failure: ${c.onFailure}\n` +
    "# keep_alive: how long Ollama keeps a model loaded after use (a cold load can take 10+ seconds on a CPU).\n" +
    `keep_alive: ${c.keepAlive}\n` +
    "# Decision models (d3) give a probability that a command or text is harmful: at or above decision_block it counts as block/injection,\n" +
    "# at or below decision_allow as allow/benign, in between as unsure.\n" +
    `decision_block: ${c.decisionBlock}\n` +
    `decision_allow: ${c.decisionAllow}\n` +
    "# The tripwire assist uses the embedding model (does tool output resemble a known injection phrasing?) and the reviewer model\n" +
    "# (is it really one?). They can raise the tripwire's level, never lower it.\n" +
    `tripwire_assist: ${c.tripwireAssist}\n` +
    `similarity_threshold: ${c.similarityThreshold}\n` +
    `reviewer_timeout_ms: ${c.reviewerTimeoutMs}\n` +
    "roles:\n" +
    ROLES.map((r) => `  ${r}:\n${list(r)}`).join("\n") +
    "\n"
  );
}

/** Every distinct tag the config refers to, with the roles that use it. */
export function requiredTags(c: ModelsConfig): Array<{ tag: string; roles: Role[] }> {
  const map = new Map<string, Role[]>();
  for (const r of ROLES) for (const t of c.roles[r]) map.set(t, [...(map.get(t) ?? []), r]);
  return [...map].map(([tag, roles]) => ({ tag, roles }));
}

/** Ollama treats "name" and "name:latest" as the same model. */
export const normalizeTag = (t: string) => (t.includes(":") ? t : `${t}:latest`);
