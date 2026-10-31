import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { McpTool } from "./fingerprint.js";
import type { ServerDef } from "./identity.js";

export interface ListToolsResult {
  tools: McpTool[];
  serverName?: string;
  serverVersion?: string;
}

export interface ListToolsOptions {
  timeoutMs?: number;
  /** Environment used to expand ${VAR} in server env/headers (defaults to process.env). */
  expandFrom?: NodeJS.ProcessEnv;
}

const PROTOCOL = "2025-06-18";
const CLIENT = { name: "cephalo", version: "0.1.0" };
const MAX_PAGES = 50;

/** `${VAR}` and `${VAR:-default}` expansion, as agent configs commonly use. */
function expand(s: string, env: NodeJS.ProcessEnv): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, k: string, d: string | undefined) => env[k] ?? d ?? "");
}
const expandMap = (m: Record<string, string> | undefined, env: NodeJS.ProcessEnv) =>
  Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => [k, expand(v, env)]));

function toTools(result: any): { tools: McpTool[]; next?: string } {
  const list = Array.isArray(result?.tools) ? result.tools : [];
  const tools: McpTool[] = list
    .filter((t: any) => t && typeof t.name === "string")
    .map((t: any) => ({
      name: t.name,
      ...(t.title !== undefined ? { title: t.title } : {}),
      ...(t.description !== undefined ? { description: t.description } : {}),
      ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
      ...(t.outputSchema !== undefined ? { outputSchema: t.outputSchema } : {}),
      ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
    }));
  return { tools, next: typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined };
}

/** Quote one argument for cmd.exe. */
const winQuote = (a: string) => (/[\s"&|<>^()%!]/.test(a) || a === "" ? `"${a.replace(/"/g, '""')}"` : a);

function killTree(child: ChildProcess) {
  try {
    if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
    else child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

/** Ask a stdio MCP server for its tools (initialize -> initialized -> tools/list, following pages). */
async function listStdio(def: ServerDef, o: Required<Pick<ListToolsOptions, "timeoutMs">> & ListToolsOptions): Promise<ListToolsResult> {
  const base = o.expandFrom ?? process.env;
  const env = { ...process.env, ...expandMap(def.env, base) };
  const args = (def.args ?? []).map((a) => expand(a, base));
  const command = expand(def.command!, base);
  const child =
    process.platform === "win32" && !/\.exe$/i.test(command)
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${[command, ...args].map(winQuote).join(" ")}"`], { env, windowsHide: true, windowsVerbatimArguments: true, stdio: ["pipe", "pipe", "pipe"] })
      : spawn(command, args, { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr?.resume();
  child.stdin?.on("error", () => {}); /* a server that dies early closes the pipe; the exit handler reports it */
  const pending = new Map<number, (m: any) => void>();
  let spawnError: Error | null = null;
  child.on("error", (e) => {
    spawnError = e;
    for (const r of pending.values()) r({ error: { message: `could not start: ${e.message}` } });
  });
  child.on("exit", (code) => {
    for (const r of pending.values()) r({ error: { message: `server exited (code ${code}) before answering` } });
    pending.clear();
  });
  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    try {
      const m = JSON.parse(line);
      if (typeof m?.id === "number" && pending.has(m.id)) {
        pending.get(m.id)!(m);
        pending.delete(m.id);
      }
    } catch {
      /* not JSON (a banner on stdout): ignore */
    }
  });
  let nextId = 1;
  const send = (obj: unknown) => child.stdin!.write(JSON.stringify(obj) + "\n");
  const request = (method: string, params?: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out after ${o.timeoutMs}ms waiting for ${method}`));
      }, o.timeoutMs);
      pending.set(id, (m) => {
        clearTimeout(timer);
        m.error ? reject(new Error(`${method}: ${m.error.message ?? JSON.stringify(m.error)}`)) : resolve(m.result);
      });
      if (spawnError) return;
      send({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    });
  try {
    const init = await request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const r = await request("tools/list", cursor ? { cursor } : {});
      const page = toTools(r);
      tools.push(...page.tools);
      if (!page.next) break;
      cursor = page.next;
    }
    return { tools, serverName: init?.serverInfo?.name, serverVersion: init?.serverInfo?.version };
  } finally {
    rl.close();
    killTree(child);
  }
}

/** Pull the JSON-RPC message with `id` out of a response that is either JSON or an SSE stream. */
function parseRpcBody(contentType: string, body: string, id: number): any {
  if (contentType.includes("text/event-stream")) {
    for (const block of body.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        const m = JSON.parse(data);
        if (m?.id === id) return m;
      } catch {
        /* keep looking */
      }
    }
    throw new Error("the event stream ended without an answer");
  }
  const m = JSON.parse(body);
  return Array.isArray(m) ? m.find((x) => x?.id === id) : m;
}

/** Ask a Streamable-HTTP MCP server for its tools. */
async function listHttp(def: ServerDef, o: Required<Pick<ListToolsOptions, "timeoutMs">> & ListToolsOptions): Promise<ListToolsResult> {
  const base = o.expandFrom ?? process.env;
  const url = expand(def.url!, base);
  const extra = expandMap(def.headers, base);
  let session: string | undefined;
  let nextId = 1;
  const post = async (body: unknown, id?: number) => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
        "mcp-protocol-version": PROTOCOL,
        ...extra,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(o.timeoutMs),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) session = sid;
    if (id === undefined) {
      await res.text().catch(() => "");
      return null;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    const m = parseRpcBody(res.headers.get("content-type") ?? "", await res.text(), id);
    if (!m) throw new Error("no answer in the response");
    if (m.error) throw new Error(m.error.message ?? JSON.stringify(m.error));
    return m.result;
  };
  const init = await post({ jsonrpc: "2.0", id: nextId, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT } }, nextId++);
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const id = nextId++;
    const r = await post({ jsonrpc: "2.0", id, method: "tools/list", params: cursor ? { cursor } : {} }, id);
    const page = toTools(r);
    tools.push(...page.tools);
    if (!page.next) break;
    cursor = page.next;
  }
  return { tools, serverName: init?.serverInfo?.name, serverVersion: init?.serverInfo?.version };
}

/**
 * Connect to a server and return the tool definitions it reports.
 * NOTE: for stdio servers this RUNS THE SERVER'S COMMAND. Callers must only do that for servers the user
 * has approved (the allowlist); `cephalo mcp pin/scan` enforce that.
 */
export async function listTools(def: ServerDef, opts: ListToolsOptions = {}): Promise<ListToolsResult> {
  const o = { timeoutMs: 20000, ...opts };
  if (def.kind === "http") {
    if (def.transport === "sse") throw new Error("legacy SSE transport is not supported by scan yet (Streamable HTTP and stdio are)");
    return listHttp(def, o);
  }
  return listStdio(def, o);
}

export type ListToolsFn = typeof listTools;
