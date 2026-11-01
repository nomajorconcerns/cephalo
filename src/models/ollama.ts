import { isLoopbackHost } from "./config.js";

export type FetchLike = (url: string, init?: { method?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export interface OllamaOptions {
  host: string;
  timeoutMs: number;
  fetch?: FetchLike;
}

export interface OllamaStatus {
  reachable: boolean;
  version?: string;
  installed: string[];
  error?: string;
}

/** Ask the local Ollama what it has. Never throws: a down server is a normal state. */
export async function ollamaStatus(o: OllamaOptions): Promise<OllamaStatus> {
  if (!isLoopbackHost(o.host)) return { reachable: false, installed: [], error: `refusing non-local host ${o.host}` };
  const f: FetchLike = o.fetch ?? ((url, init) => fetch(url, init) as any);
  const get = async (p: string) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), o.timeoutMs);
    try {
      const r = await f(`${o.host}${p}`, { method: "GET", signal: ac.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const tags = await get("/api/tags");
    const installed: string[] = Array.isArray(tags?.models) ? tags.models.map((m: any) => String(m?.name ?? m?.model ?? "")).filter(Boolean) : [];
    let version: string | undefined;
    try {
      const v = await get("/api/version");
      if (typeof v?.version === "string") version = v.version;
    } catch {
      /* version is optional */
    }
    return { reachable: true, version, installed };
  } catch (e) {
    const err = e as Error;
    return { reachable: false, installed: [], error: err.name === "AbortError" ? `no answer within ${o.timeoutMs} ms` : err.message };
  }
}
