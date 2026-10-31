import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPlatform } from "../platform.js";
import { fingerprintServer, snapshotTool, type McpTool, type PinnedTool, type ToolDiff } from "./fingerprint.js";

/** What a scan found that needs a person to look at it. Cleared by approving again. */
export interface DriftFlag {
  detectedAt: string;
  changed: string[];
  added: string[];
  removed: string[];
}

export interface PinnedServer {
  /** Fingerprint of the whole approved tool set. */
  fingerprint: string;
  approvedAt: string;
  approvedBy: string;
  /** Config name at approval time. A label only; the store is keyed by identity. */
  label?: string;
  tools: Record<string, PinnedTool>;
  drift?: DriftFlag;
}

export interface ApprovalStore {
  version: 1;
  /** Keyed by server identity (`cmd:...` / `url:...`), never by name. */
  servers: Record<string, PinnedServer>;
}

export function approvalStorePath(): string {
  return path.join(getPlatform().dataDir(), "mcp-tools.json");
}

export const emptyStore = (): ApprovalStore => ({ version: 1, servers: {} });

export function loadApprovals(file: string = approvalStorePath()): ApprovalStore {
  if (!fs.existsSync(file)) return emptyStore();
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    if (j && j.version === 1 && typeof j.servers === "object" && j.servers) return j as ApprovalStore;
  } catch {
    /* fall through */
  }
  process.stderr.write(`cephalo: ${file} is unreadable; treating every MCP server as unpinned\n`);
  return emptyStore();
}

/** Strict read for commands that rewrite the file: refuse rather than overwrite something we cannot parse. */
function loadForWrite(file: string): ApprovalStore {
  if (!fs.existsSync(file)) return emptyStore();
  const j = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  if (!j || j.version !== 1 || typeof j.servers !== "object") throw new Error(`${file} is not a Cephalo approvals file, refusing to touch it`);
  return j as ApprovalStore;
}

function write(file: string, store: ApprovalStore): string | null {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let bak: string | null = null;
  if (fs.existsSync(file)) {
    bak = `${file}.cephalo-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(file, bak);
  }
  const tmpFile = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2) + "\n", "utf8");
  fs.renameSync(tmpFile, file);
  return bak;
}

function user(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME ?? process.env.USER ?? "unknown";
  }
}

/** Approve exactly these tool definitions for this server identity (first pin, or re-approval after a change). */
export function pinServer(identity: string, tools: McpTool[], label?: string, file: string = approvalStorePath()): { backup: string | null; fingerprint: string } {
  const store = loadForWrite(file);
  const pinned: Record<string, PinnedTool> = {};
  for (const t of tools) pinned[t.name] = snapshotTool(t);
  const fingerprint = fingerprintServer(tools);
  store.servers[identity] = { fingerprint, approvedAt: new Date().toISOString(), approvedBy: user(), ...(label ? { label } : {}), tools: pinned };
  return { backup: write(file, store), fingerprint };
}

/** Remember that a scan found changes (keeps the call-time block in place until someone re-approves). */
export function flagDrift(identity: string, diff: ToolDiff, file: string = approvalStorePath()): void {
  const store = loadForWrite(file);
  const s = store.servers[identity];
  if (!s) return;
  s.drift = { detectedAt: new Date().toISOString(), changed: diff.changed.map((c) => c.name), added: diff.added, removed: diff.removed };
  write(file, store);
}

export function clearDrift(identity: string, file: string = approvalStorePath()): void {
  const store = loadForWrite(file);
  const s = store.servers[identity];
  if (s?.drift) {
    delete s.drift;
    write(file, store);
  }
}
