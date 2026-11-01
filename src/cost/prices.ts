import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";

/** US dollars per million tokens. `cacheWrite` is the 5-minute cache write price. */
export interface Price {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface Tokens {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export const NO_TOKENS: Tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

/**
 * Anthropic list prices (docs.anthropic.com/en/docs/about-claude/pricing), keyed by model-name prefix; the longest prefix wins.
 * These are API list prices. A subscription plan is a flat fee, so a figure built from them is an estimate of what the same
 * tokens would cost on the API, not what you were charged. Add or change models in ~/.cephalo/prices.yml.
 */
export const DEFAULT_PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-1": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-opus-4": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-sonnet-4": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  "claude-haiku-3-5": { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
};

export function pricesPath(): string {
  return path.join(os.homedir(), ".cephalo", "prices.yml");
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/** Defaults plus the user's overrides. A bad file is ignored (with a note), never fatal. */
export function loadPrices(file = pricesPath()): { prices: Record<string, Price>; notes: string[] } {
  const prices = { ...DEFAULT_PRICES };
  const notes: string[] = [];
  if (!fs.existsSync(file)) return { prices, notes };
  try {
    const doc = parse(fs.readFileSync(file, "utf8"));
    for (const [model, v] of Object.entries((doc && typeof doc === "object" ? doc : {}) as Record<string, any>)) {
      const p = { input: num(v?.input), output: num(v?.output), cacheWrite: num(v?.cache_write), cacheRead: num(v?.cache_read) };
      if (p.input === undefined || p.output === undefined) {
        notes.push(`${file}: ${model} needs numeric input and output (USD per million tokens); ignored`);
        continue;
      }
      prices[model] = { input: p.input, output: p.output, cacheWrite: p.cacheWrite ?? p.input * 1.25, cacheRead: p.cacheRead ?? p.input * 0.1 };
    }
  } catch (e) {
    notes.push(`${file} could not be read (${(e as Error).message}); using the built-in prices`);
  }
  return { prices, notes };
}

/** Model names come as "claude-opus-5-5", "claude-opus-4-5-20251101", "claude-sonnet-4-5@x"... Longest matching prefix. */
export function priceFor(model: string | undefined, prices: Record<string, Price>): Price | null {
  if (!model) return null;
  const m = model.toLowerCase();
  let best: string | null = null;
  for (const k of Object.keys(prices)) if (m.startsWith(k.toLowerCase()) && (best === null || k.length > best.length)) best = k;
  return best ? prices[best]! : null;
}

export function costOf(t: Tokens, p: Price): number {
  return (t.input * p.input + t.output * p.output + t.cacheWrite * p.cacheWrite + t.cacheRead * p.cacheRead) / 1_000_000;
}

export const addTokens = (a: Tokens, b: Tokens): Tokens => ({ input: a.input + b.input, output: a.output + b.output, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead });
