import { isLoopbackHost } from "./config.js";
import type { FetchLike } from "./ollama.js";

export interface ChatOptions {
  host: string;
  model: string;
  system: string;
  user: string;
  /** Milliseconds left for this one request. */
  timeoutMs: number;
  keepAlive?: string;
  fetch?: FetchLike;
}

/**
 * One non-streaming, JSON-formatted, temperature-0 chat call to the local Ollama.
 * Returns the reply text. Throws on any failure (the caller decides what a failure means).
 * Thinking is switched off to keep it fast; a model that rejects that flag is retried without it.
 */
export async function ollamaChat(o: ChatOptions): Promise<string> {
  if (!isLoopbackHost(o.host)) throw new Error(`refusing non-local host ${o.host}`);
  const f: FetchLike = o.fetch ?? ((url, init) => fetch(url, init) as any);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(1, o.timeoutMs));
  const call = async (think: boolean) => {
    const body = {
      model: o.model,
      stream: false,
      format: "json",
      ...(think ? {} : { think: false }),
      ...(o.keepAlive ? { keep_alive: o.keepAlive } : {}),
      options: { temperature: 0, num_predict: 200 },
      messages: [
        { role: "system", content: o.system },
        { role: "user", content: o.user },
      ],
    };
    const r = await f(`${o.host}/api/chat`, { method: "POST", signal: ac.signal, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    let j: any = {};
    try {
      j = await r.json();
    } catch {
      /* non-JSON error body */
    }
    return { ok: r.ok, status: r.status, j };
  };
  try {
    let r = await call(false);
    if (!r.ok && r.status === 400 && /think/i.test(String(r.j?.error ?? ""))) r = await call(true);
    if (!r.ok) throw new Error(String(r.j?.error ?? `HTTP ${r.status}`));
    const content = r.j?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("empty reply");
    return content;
  } catch (e) {
    const err = e as Error;
    throw err.name === "AbortError" ? new Error(`no answer within ${o.timeoutMs} ms`) : err;
  } finally {
    clearTimeout(timer);
  }
}
