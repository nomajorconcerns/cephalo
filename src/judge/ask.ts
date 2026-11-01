import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cephaloDir } from "../rules.js";
import type { ModelsConfig } from "../models/config.js";
import { ollamaChat } from "../models/chat.js";
import { ollamaCapabilities, ollamaNoul } from "../models/systemone.js";
import type { FetchLike } from "../models/ollama.js";

export function judgeCachePath(): string {
  return path.join(cephaloDir(), "judge-cache.json");
}

export interface Answer {
  verdict: string;
  reason: string;
}

export interface Asked extends Answer {
  model: string;
  cached: boolean;
  ms: number;
}

const CACHE_TTL_MS = 24 * 3600 * 1000;
const CACHE_MAX = 500;

type CacheFile = Record<string, Answer & { model: string; t: number }>;

/** One cache entry per (purpose, model, text): a command verdict never answers a text review. */
const cacheKey = (ns: string, model: string, text: string) => crypto.createHash("sha256").update(`${ns}\0${model}\0${text}`).digest("hex").slice(0, 32);

function readCache(file: string): CacheFile {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

function writeCache(file: string, cache: CacheFile, now: number): void {
  try {
    const live = Object.entries(cache).filter(([, v]) => now - v.t < CACHE_TTL_MS).sort((a, b) => b[1].t - a[1].t).slice(0, CACHE_MAX);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(live)), "utf8");
  } catch {
    /* a cache that cannot be written only costs speed */
  }
}

/** A model's free-text reason, made safe to log and print: one line, short, no control or bidi characters. */
export const cleanReason = (s: unknown): string =>
  typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) : "";

/** Read the first JSON object in a model reply, or null. */
export function parseJsonObject(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[^{}]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

/** Ask one model. `timeLeftMs` is what remains of the shared budget. Return null for an unusable reply; throw for a failure. */
export type Run = (model: string, timeLeftMs: number) => Promise<Answer | null>;

export interface AskOptions {
  models: string[];
  /** One time budget for all models tried. */
  timeoutMs: number;
  /** What the answer is about (the cache is keyed on this, per model and purpose). */
  subject: string;
  purpose: string;
  run: Run;
  cacheFile?: string;
  now?: () => number;
}

/**
 * Ask each model in turn until one gives a usable answer. Never throws: a model that is down, slow,
 * missing or confused is skipped, and null means nobody could answer. Good answers are cached for 24 hours.
 */
export async function askModels(o: AskOptions): Promise<Asked | null> {
  const now = o.now ?? Date.now;
  const started = now();
  const cacheFile = o.cacheFile ?? judgeCachePath();
  const cache = readCache(cacheFile);
  const deadline = started + o.timeoutMs;
  for (const model of o.models) {
    // A model's cached answer is used at that model's turn, so a backup's old answer never beats the preferred model.
    const hit = cache[cacheKey(o.purpose, model, o.subject)];
    if (hit && started - hit.t < CACHE_TTL_MS) return { verdict: hit.verdict, reason: hit.reason, model, cached: true, ms: 0 };
    const left = deadline - now();
    if (left < 100) break;
    try {
      const parsed = await o.run(model, left);
      if (!parsed) continue;
      cache[cacheKey(o.purpose, model, o.subject)] = { ...parsed, model, t: now() };
      writeCache(cacheFile, cache, now());
      return { ...parsed, model, cached: false, ms: now() - started };
    } catch {
      /* try the next model */
    }
  }
  return null;
}

export interface RunnerSpec {
  config: ModelsConfig;
  fetch?: FetchLike;
  /** For chat models: ask for JSON and parse it. */
  chat: { system: string; user: string; parse: (text: string) => Answer | null };
  /** For decision models (d3): a yes/no question, and what a probability of "true" means. */
  decision: { state: string; instructions: string; trueMeans: string; falseMeans: string; toAnswer: (p: number) => Answer };
}

/**
 * Build the per-model call: decision models (found out from Ollama's capabilities) get a yes/no question and
 * answer with a probability; everything else is asked in chat and must reply with JSON.
 */
export function makeRun(s: RunnerSpec): Run {
  return async (model, left) => {
    const started = Date.now();
    const caps = await ollamaCapabilities(s.config.host, model, Math.min(2000, left), s.fetch);
    const rest = () => Math.max(1, left - (Date.now() - started));
    if (caps.includes("decision")) {
      const p = await ollamaNoul({ host: s.config.host, model, ...s.decision, timeoutMs: rest(), keepAlive: s.config.keepAlive, fetch: s.fetch });
      return s.decision.toAnswer(p);
    }
    const text = await ollamaChat({ host: s.config.host, model, ...s.chat, timeoutMs: rest(), keepAlive: s.config.keepAlive, fetch: s.fetch });
    return s.chat.parse(text);
  };
}
