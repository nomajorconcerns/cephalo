import { isLoopbackHost } from "./config.js";
import type { FetchLike } from "./ollama.js";

/**
 * Decision models (such as d3) do not chat. They answer yes/no questions with a probability, through
 * Ollama's /v1/systemone endpoint. They are fast (no text is generated) and the answer is a number, not prose.
 */
export interface NoulOptions {
  host: string;
  model: string;
  /** The evidence: what to judge. */
  state: string;
  /** The yes/no question. */
  instructions: string;
  /** What "true" and "false" mean for this question. */
  trueMeans: string;
  falseMeans: string;
  timeoutMs: number;
  keepAlive?: string;
  fetch?: FetchLike;
}

/** Probability (0..1) that the answer to the question is "true". Throws on any failure or odd reply. */
export async function ollamaNoul(o: NoulOptions): Promise<number> {
  if (!isLoopbackHost(o.host)) throw new Error(`refusing non-local host ${o.host}`);
  const f: FetchLike = o.fetch ?? ((url, init) => fetch(url, init) as any);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(1, o.timeoutMs));
  try {
    const body = {
      model: o.model,
      state: o.state,
      questions: { q: { type: "noul", instructions: o.instructions, criteria: { true: o.trueMeans, false: o.falseMeans } } },
      ...(o.keepAlive ? { keep_alive: o.keepAlive } : {}),
    };
    const r = await f(`${o.host}/v1/systemone`, { method: "POST", signal: ac.signal, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    let j: any = {};
    try {
      j = await r.json();
    } catch {
      /* non-JSON error body */
    }
    if (!r.ok) throw new Error(String(j?.error ?? `HTTP ${r.status}`));
    const p = j?.answers?.q?.noul;
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) throw new Error("unexpected decision reply");
    return p;
  } catch (e) {
    const err = e as Error;
    throw err.name === "AbortError" ? new Error(`no answer within ${o.timeoutMs} ms`) : err;
  } finally {
    clearTimeout(timer);
  }
}

/** What a model can do ("decision", "completion", "embedding", ...), from Ollama. Empty when it cannot be found out. Never throws. */
export async function ollamaCapabilities(host: string, model: string, timeoutMs: number, fetchImpl?: FetchLike): Promise<string[]> {
  if (!isLoopbackHost(host)) return [];
  const f: FetchLike = fetchImpl ?? ((url, init) => fetch(url, init) as any);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(1, timeoutMs));
  try {
    const r = await f(`${host}/api/show`, { method: "POST", signal: ac.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j?.capabilities) ? j.capabilities.filter((c: unknown): c is string => typeof c === "string") : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
