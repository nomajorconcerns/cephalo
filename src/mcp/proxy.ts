import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { appendAudit, type AuditEntry } from "../audit.js";
import { redactParams } from "../redact.js";
import { currentUser } from "../user.js";
import { killTree, spawnServer } from "./client.js";
import { diffIsEmpty, diffTools, type McpTool } from "./fingerprint.js";
import { identityOf } from "./identity.js";
import { loadMcpPolicy, matchAllow, type McpPolicy } from "./policy.js";
import { approvalStorePath, clearDrift, flagDrift, loadApprovals } from "./store.js";

export interface ProxyOptions {
  /** The real server to run. */
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** Name shown in the log (never used for decisions). */
  label?: string;
  input: Readable;
  output: Writable;
  errput?: Writable;
  /** Test hooks. */
  policy?: McpPolicy;
  approvalsFile?: string;
  auditFile?: string;
  refreshTimeoutMs?: number;
}

type Bad = "changed" | "unapproved" | "unpinned";

const BLOCK_RULES: Record<Bad, { id: string; why: (n: string) => string }> = {
  changed: { id: "mcp-tool-changed", why: (n) => `the definition of "${n}" changed since you approved it (possible rug pull). Review and re-approve with: cephalo mcp scan, then cephalo mcp approve` },
  unapproved: { id: "mcp-tool-unapproved", why: (n) => `"${n}" is not one of the approved tools of this MCP server (it may be new). Review it with: cephalo mcp scan` },
  unpinned: { id: "mcp-unpinned", why: () => "this MCP server's tools were never approved. Pin them with: cephalo mcp pin" },
};

/**
 * Stand between an MCP client and a stdio MCP server. Everything passes through untouched except:
 *  - `tools/list` answers hide tools whose definition changed (or that were never approved), so the model never reads them;
 *  - `tools/call` for such tools is refused with an error the model can read;
 *  - when the server announces `notifications/tools/list_changed` the proxy re-reads the list at once (live rug-pull detection);
 *  - every call is written to the audit log with its (redacted) parameters, the user and the time.
 * In audit mode nothing is hidden or refused, only logged.
 */
export async function runProxy(o: ProxyOptions): Promise<number> {
  const errput = o.errput ?? process.stderr;
  const policy = o.policy ?? loadMcpPolicy();
  const enforce = policy.mode === "enforce";
  const def = { kind: "stdio" as const, command: o.command, args: o.args };
  const identity = identityOf(def);
  const label = o.label ?? identity.replace(/^cmd:/, "").split(" ")[0];
  const approvalsFile = o.approvalsFile ?? approvalStorePath();

  const log = (e: Partial<AuditEntry> & { tool: string; decision: "allow" | "block" }) => {
    try {
      appendAudit({ ts: new Date().toISOString(), agent: "proxy", user: currentUser(), server: label, serverId: identity, ...e }, o.auditFile);
    } catch (err) {
      errput.write(`cephalo: audit log failed: ${(err as Error).message}\n`);
    }
  };

  if (enforce && !matchAllow(policy, def)) {
    const msg = `MCP server is not on the allowlist (${identity})`;
    errput.write(`cephalo: refusing to start: ${msg}. Review with: cephalo mcp list\n`);
    log({ tool: "proxy-start", decision: "block", rule: "mcp-not-allowed", note: msg });
    return 1;
  }

  const child = spawnServer(o.command, o.args, { ...process.env, ...o.env });
  child.stderr?.on("data", (d) => errput.write(d));
  child.stdin?.on("error", () => {});

  const send = (obj: unknown) => o.output.write(typeof obj === "string" ? `${obj}\n` : `${JSON.stringify(obj)}\n`);
  const toServer = (line: string) => child.stdin?.write(`${line}\n`);

  /* ---- live view of what the server offers right now ---- */
  let live = new Map<string, McpTool>();
  let liveKnown = false;
  const pinOf = () => loadApprovals(approvalsFile).servers[identity];

  /** Tools that must not be offered or called, and why. Empty when not pinned (unless requirePin). */
  function badTools(): Map<string, Bad> {
    const bad = new Map<string, Bad>();
    const pin = pinOf();
    if (!pin) {
      if (policy.requirePin) for (const n of live.keys()) bad.set(n, "unpinned");
      return bad;
    }
    if (liveKnown) {
      const d = diffTools(pin.tools, [...live.values()]);
      for (const c of d.changed) bad.set(c.name, "changed");
      for (const n of d.added) bad.set(n, "unapproved");
    } else {
      for (const n of pin.drift?.changed ?? []) bad.set(n, "changed");
    }
    return bad;
  }

  /* ---- internal requests (ids "cephalo-N") to refresh the list ---- */
  const internal = new Map<string, (m: any) => void>();
  let nextInternal = 1;
  const ask = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = `cephalo-${nextInternal++}`;
      const timer = setTimeout(() => {
        internal.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }, o.refreshTimeoutMs ?? 10000);
      internal.set(id, (m) => {
        clearTimeout(timer);
        m.error ? reject(new Error(m.error.message ?? "error")) : resolve(m.result);
      });
      toServer(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });

  let refreshing: Promise<void> | null = null;
  function refresh(reason: string): Promise<void> {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const tools: McpTool[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < 50; i++) {
          const r = await ask("tools/list", cursor ? { cursor } : {});
          tools.push(...(Array.isArray(r?.tools) ? r.tools : []));
          if (typeof r?.nextCursor === "string" && r.nextCursor) cursor = r.nextCursor;
          else break;
        }
        live = new Map(tools.map((t) => [t.name, t]));
        liveKnown = true;
        const pin = pinOf();
        if (pin) {
          const d = diffTools(pin.tools, tools);
          try {
            if (diffIsEmpty(d)) {
              if (pin.drift) clearDrift(identity, approvalsFile);
            } else flagDrift(identity, d, approvalsFile);
          } catch (e) {
            errput.write(`cephalo: could not update ${approvalsFile}: ${(e as Error).message}\n`);
          }
          if (!diffIsEmpty(d)) {
            const names = [...d.changed.map((c) => `${c.name} (changed)`), ...d.added.map((n) => `${n} (new)`), ...d.removed.map((n) => `${n} (removed)`)];
            log({ tool: "tools/list_changed", decision: enforce ? "block" : "allow", rule: enforce ? "mcp-tool-changed" : undefined, note: `${reason}: ${names.join(", ")}`, pin: pin.fingerprint.slice(0, 12) });
          }
        }
      } catch (e) {
        errput.write(`cephalo: could not re-read the tool list (${(e as Error).message})\n`);
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  /* ---- bookkeeping for client requests ---- */
  const pendingList = new Map<string | number, { cursor?: string }>();

  async function onClientLine(line: string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return void toServer(line);
    }
    if (!msg || Array.isArray(msg) || typeof msg !== "object") return void toServer(line);
    if (msg.method === "tools/list" && msg.id !== undefined) {
      pendingList.set(msg.id, { cursor: msg.params?.cursor });
      return void toServer(line);
    }
    if (msg.method === "tools/call" && msg.id !== undefined) {
      const name = String(msg.params?.name ?? "");
      const pin = pinOf();
      if (enforce && (pin || policy.requirePin) && !liveKnown) await refresh("first call");
      const bad = badTools();
      let kind: Bad | undefined = bad.get(name);
      if (!kind && enforce && pin && !(name in pin.tools) && !live.has(name)) kind = "unapproved";
      const entry = { tool: `mcp:${name}`, params: redactParams(msg.params?.arguments), ...(pin ? { pin: pin.fingerprint.slice(0, 12) } : {}) };
      if (kind && enforce) {
        const r = BLOCK_RULES[kind];
        log({ ...entry, decision: "block", rule: r.id });
        return void send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: `🛑 Cephalo blocked this (rule: ${r.id} - ${r.why(name)}). If it is intended, ask the user to run it themselves.` }], isError: true },
        });
      }
      log({ ...entry, decision: "allow", ...(kind ? { note: `${kind} (audit mode: allowed and logged)` } : {}), ...(!pin ? { note: "server not pinned" } : {}) });
      return void toServer(line);
    }
    toServer(line);
  }

  function onServerLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return void send(line);
    }
    if (!msg || Array.isArray(msg) || typeof msg !== "object") return void send(line);
    if (typeof msg.id === "string" && internal.has(msg.id)) {
      const r = internal.get(msg.id)!;
      internal.delete(msg.id);
      return r(msg);
    }
    if (msg.id !== undefined && pendingList.has(msg.id)) {
      const req = pendingList.get(msg.id)!;
      pendingList.delete(msg.id);
      if (Array.isArray(msg.result?.tools)) {
        if (!req.cursor) live = new Map();
        for (const t of msg.result.tools) if (t && typeof t.name === "string") live.set(t.name, t);
        if (!msg.result.nextCursor) liveKnown = true;
        if (enforce) {
          const bad = badTools();
          if (bad.size) {
            const dropped = msg.result.tools.filter((t: McpTool) => bad.has(t.name)).map((t: McpTool) => t.name);
            msg.result.tools = msg.result.tools.filter((t: McpTool) => !bad.has(t.name));
            if (dropped.length) log({ tool: "tools/list", decision: "block", rule: "mcp-tool-changed", note: `hidden from the model: ${dropped.join(", ")}` });
            return void send(msg);
          }
        }
      }
      return void send(line);
    }
    if (msg.method === "notifications/tools/list_changed") {
      send(line);
      setTimeout(() => void refresh("server announced a tool list change"), 50);
      return;
    }
    send(line);
  }

  /* ---- wire everything up; client lines are handled strictly in order ---- */
  let queue: Promise<void> = Promise.resolve();
  const clientRl = createInterface({ input: o.input });
  clientRl.on("line", (line) => {
    if (!line.trim()) return;
    queue = queue.then(() => onClientLine(line)).catch((e) => {
      errput.write(`cephalo: proxy error: ${(e as Error).message}\n`);
    });
  });
  const serverRl = createInterface({ input: child.stdout! });
  serverRl.on("line", (line) => {
    if (line.trim()) onServerLine(line);
  });

  const code = await new Promise<number>((resolve) => {
    let done = false;
    const finish = (c: number) => {
      if (done) return;
      done = true;
      resolve(c);
    };
    child.on("exit", (c) => finish(c ?? 0));
    child.on("error", (e) => {
      errput.write(`cephalo: could not start the MCP server: ${e.message}\n`);
      finish(1);
    });
    clientRl.on("close", () => {
      killTree(child);
      setTimeout(() => finish(0), 1500).unref();
    });
  });
  clientRl.close();
  serverRl.close();
  await new Promise<void>((r) => o.output.write("", () => r()));
  return code;
}
