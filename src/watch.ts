import fs from "node:fs";
import { auditPath, entrySubject, readAudit, type AuditEntry } from "./audit.js";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

export interface TailState {
  offset: number;
  /** Bytes of an incomplete last line, kept until its newline arrives. */
  carry: string;
}

/** Remove control characters so a logged command can never inject terminal escape sequences. */
export function sanitize(s: string): string {
  return s.replace(/\r?\n/g, " \u21b5 ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "\u00b7");
}

export function formatWatchLine(e: AuditEntry, opts: { color: boolean; width?: number }): string {
  const t = new Date(e.ts);
  const time = Number.isNaN(t.getTime())
    ? "--:--:--"
    : [t.getHours(), t.getMinutes(), t.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
  const label = e.decision === "block" ? "BLOCK" : "ALLOW";
  const paint = (s: string, code: string) => (opts.color ? `${ESC}${code}m${s}${RESET}` : s);
  const decision = paint(label, e.decision === "block" ? "1;31" : "32");
  const who = `${e.agent}/${e.tool}`;
  const rule = e.rule ? ` ${paint(`[${e.rule}]`, "33")}` : "";
  const err = e.error ? ` ${paint(`(error: ${sanitize(e.error)})`, "90")}` : "";
  const prefix = `${paint(time, "90")}  ${decision}  ${sanitize(who)}${rule}  `;
  let what = sanitize(entrySubject(e));
  if (opts.width) {
    // visible prefix length: time(8) + 2 + 5 + 2 + who + rule + 2
    const visible = 8 + 2 + 5 + 2 + who.length + (e.rule ? e.rule.length + 3 : 0) + 2;
    const room = opts.width - visible - 1;
    if (room > 3 && what.length > room) what = what.slice(0, room - 1) + "\u2026";
  }
  return `${prefix}${what}${err}`;
}

/**
 * Read whatever was appended to `file` since `state`. Handles a missing file, a partial last line,
 * and truncation/rotation (file shorter than our offset: start over from the top).
 */
export function readNewEntries(file: string, state: TailState): AuditEntry[] {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    state.offset = 0;
    state.carry = "";
    return [];
  }
  if (size < state.offset) {
    state.offset = 0;
    state.carry = "";
  }
  if (size === state.offset) return [];
  const fd = fs.openSync(file, "r");
  let chunk: Buffer;
  try {
    chunk = Buffer.alloc(size - state.offset);
    fs.readSync(fd, chunk, 0, chunk.length, state.offset);
  } finally {
    fs.closeSync(fd);
  }
  state.offset = size;
  const text = state.carry + chunk.toString("utf8");
  const parts = text.split("\n");
  state.carry = parts.pop() ?? "";
  const out: AuditEntry[] = [];
  for (const line of parts) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as AuditEntry);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

export interface WatchOptions {
  file?: string;
  blocked?: boolean;
  /** Existing entries to show before following (default 10). */
  last?: number;
  color: boolean;
  width?: number;
  intervalMs?: number;
  write: (line: string) => void;
  /** Abort to stop watching (Ctrl+C in the CLI). */
  signal?: AbortSignal;
}

/** Print the last N entries, then follow the audit log until aborted. Resolves when stopped. */
export function runWatch(o: WatchOptions): Promise<void> {
  const file = o.file ?? auditPath();
  const show = (e: AuditEntry) => {
    if (o.blocked && e.decision !== "block") return;
    o.write(formatWatchLine(e, { color: o.color, width: o.width }));
  };
  o.write(`Watching ${file}${o.blocked ? " (blocked only)" : ""}  -  Ctrl+C to stop`);
  for (const e of readAudit({ blocked: o.blocked, limit: o.last ?? 10 }, file)) {
    o.write(formatWatchLine(e, { color: o.color, width: o.width }));
  }
  // Start following from the current end of file so history is not printed twice.
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    /* not created yet: follow from 0 */
  }
  const state: TailState = { offset: size, carry: "" };
  // If the file ends mid-line, start at the last newline so the half-written entry is picked up whole.
  if (size > 0) {
    try {
      const fd = fs.openSync(file, "r");
      const b = Buffer.alloc(1);
      fs.readSync(fd, b, 0, 1, size - 1);
      fs.closeSync(fd);
      if (b[0] !== 0x0a) {
        const all = fs.readFileSync(file);
        const nl = all.lastIndexOf(0x0a);
        state.offset = nl + 1;
      }
    } catch {
      /* best effort */
    }
  }
  return new Promise<void>((resolve) => {
    const tick = () => {
      try {
        for (const e of readNewEntries(file, state)) show(e);
      } catch (err) {
        o.write(`cephalo watch: read error: ${(err as Error).message}`);
      }
    };
    const timer = setInterval(tick, o.intervalMs ?? 250);
    const stop = () => {
      clearInterval(timer);
      tick();
      resolve();
    };
    if (o.signal?.aborted) stop();
    else o.signal?.addEventListener("abort", stop, { once: true });
  });
}
