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

export interface ModelsConfig {
  enabled: boolean;
  host: string;
  timeoutMs: number;
  roles: Record<Role, string[]>;
}

export const DEFAULT_MODELS_CONFIG: ModelsConfig = {
  enabled: false,
  host: "http://127.0.0.1:11434",
  timeoutMs: 8000,
  roles: {
    decider: ["d3:2b", "qwen3.5:4b"],
    reviewer: ["qwen3.5:9b"],
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
  if (doc.host !== undefined) {
    if (typeof doc.host === "string" && isLoopbackHost(doc.host)) config.host = doc.host.replace(/\/+$/, "");
    else problems.push(`host must be a local Ollama address such as ${config.host} (got ${JSON.stringify(doc.host)}); using ${config.host}`);
  }
  if (doc.timeout_ms !== undefined) {
    const n = doc.timeout_ms;
    if (Number.isInteger(n) && n >= 200 && n <= 120000) config.timeoutMs = n;
    else problems.push(`timeout_ms must be a whole number from 200 to 120000 (got ${JSON.stringify(n)}); using ${config.timeoutMs}`);
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
    `enabled: ${c.enabled}\n` +
    `host: ${c.host}\n` +
    `timeout_ms: ${c.timeoutMs}\n` +
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
