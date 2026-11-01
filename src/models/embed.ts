import { isLoopbackHost } from "./config.js";
import type { FetchLike } from "./ollama.js";

export interface EmbedOptions {
  host: string;
  model: string;
  input: string[];
  timeoutMs: number;
  fetch?: FetchLike;
}

/** Vectors for each input text from the local Ollama (/api/embed). Throws on any failure or odd reply. */
export async function ollamaEmbed(o: EmbedOptions): Promise<number[][]> {
  if (!isLoopbackHost(o.host)) throw new Error(`refusing non-local host ${o.host}`);
  if (o.input.length === 0) return [];
  const f: FetchLike = o.fetch ?? ((url, init) => fetch(url, init) as any);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(1, o.timeoutMs));
  try {
    const r = await f(`${o.host}/api/embed`, { method: "POST", signal: ac.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ model: o.model, input: o.input }) });
    let j: any = {};
    try {
      j = await r.json();
    } catch {
      /* non-JSON error body */
    }
    if (!r.ok) throw new Error(String(j?.error ?? `HTTP ${r.status}`));
    const e = j?.embeddings;
    if (!Array.isArray(e) || e.length !== o.input.length || !e.every((v: any) => Array.isArray(v) && v.length > 0 && v.every((x: any) => Number.isFinite(x)))) throw new Error("unexpected embedding reply");
    return e as number[][];
  } catch (err) {
    const e = err as Error;
    throw e.name === "AbortError" ? new Error(`no answer within ${o.timeoutMs} ms`) : e;
  } finally {
    clearTimeout(timer);
  }
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
