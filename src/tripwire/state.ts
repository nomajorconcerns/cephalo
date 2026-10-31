import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parse } from "yaml";
import { cephaloDir } from "../rules.js";
import type { Finding } from "./detect.js";

/* ------------------------------------------------------------------ policy */

export type TripMode = "enforce" | "warn" | "off";
export interface TripPolicy {
  mode: TripMode;
}

export const DEFAULT_TRIP_POLICY: TripPolicy = { mode: "enforce" };

export function tripPolicyPath(): string {
  return path.join(cephaloDir(), "tripwire.yml");
}

export function tripStateDir(): string {
  return path.join(cephaloDir(), "tripwire");
}

export function parseTripPolicy(text: string): { policy: TripPolicy; problems: string[] } {
  const problems: string[] = [];
  let doc: any;
  try {
    doc = parse(text) ?? {};
  } catch (e) {
    return { policy: { ...DEFAULT_TRIP_POLICY }, problems: [`tripwire.yml is not valid YAML (${(e as Error).message}); using defaults`] };
  }
  let mode: TripMode = DEFAULT_TRIP_POLICY.mode;
  if (doc?.mode !== undefined) {
    if (doc.mode === "enforce" || doc.mode === "warn" || doc.mode === "off") mode = doc.mode;
    else problems.push(`mode must be enforce, warn or off (got ${JSON.stringify(doc.mode)}); using ${mode}`);
  }
  return { policy: { mode }, problems };
}

export function loadTripPolicy(file: string = tripPolicyPath()): TripPolicy {
  if (!fs.existsSync(file)) return { ...DEFAULT_TRIP_POLICY };
  try {
    const { policy, problems } = parseTripPolicy(fs.readFileSync(file, "utf8"));
    for (const p of problems) process.stderr.write(`cephalo: ${p}\n`);
    return policy;
  } catch {
    return { ...DEFAULT_TRIP_POLICY };
  }
}

export function serializeTripPolicy(p: TripPolicy): string {
  return (
    "# Cephalo prompt-injection tripwire.\n" +
    "# enforce: after text that looks like an injection is read, risky actions in that session are blocked until you clear it.\n" +
    "# warn: the same detections are logged and the model is warned, but nothing is blocked.   off: no scanning.\n" +
    `mode: ${p.mode}\n`
  );
}

/* ------------------------------------------------------------------ session state */

export type TripLevel = "clean" | "watch" | "alert";

export interface TripEvent {
  ts: string;
  tool: string;
  level: "watch" | "alert";
  findings: Array<Pick<Finding, "id" | "severity" | "label" | "excerpt">>;
}

export interface TripState {
  agent: string;
  session: string;
  firstSeen: string;
  level: TripLevel;
  events: TripEvent[];
}

const MAX_EVENTS = 30;
const PRUNE_AFTER_MS = 48 * 3600 * 1000;

/** Key a session: the agent's session id, or (when it gives none) a hash of the working directory. */
export function sessionKey(sessionId: unknown, cwd: unknown): string {
  if (typeof sessionId === "string" && sessionId.trim()) return sessionId.trim();
  const c = typeof cwd === "string" ? cwd : "";
  return `cwd-${crypto.createHash("sha1").update(c.toLowerCase()).digest("hex").slice(0, 12)}`;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "default";
export const stateFile = (agent: string, session: string, dir: string = tripStateDir()) => path.join(dir, `${safe(agent)}-${safe(session)}.json`);

function readState(file: string): TripState | null {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    if (s && typeof s === "object" && Array.isArray(s.events) && typeof s.level === "string") return s as TripState;
  } catch {
    /* missing or corrupt: treated as clean */
  }
  return null;
}

export function loadState(agent: string, session: string, dir?: string): TripState | null {
  return readState(stateFile(agent, session, dir));
}

function prune(dir: string): void {
  try {
    const now = Date.now();
    for (const n of fs.readdirSync(dir)) {
      const f = path.join(dir, n);
      const st = fs.statSync(f);
      if (st.isFile() && now - st.mtimeMs > PRUNE_AFTER_MS) fs.rmSync(f, { force: true });
    }
  } catch {
    /* best effort */
  }
}

/** Record a detection for a session. The level only ever goes up (clean < watch < alert) until cleared by the user. */
export function recordEvent(agent: string, session: string, ev: TripEvent, dir: string = tripStateDir()): TripState {
  fs.mkdirSync(dir, { recursive: true });
  const file = stateFile(agent, session, dir);
  const cur = readState(file) ?? { agent, session, firstSeen: ev.ts, level: "clean" as TripLevel, events: [] };
  const rank = { clean: 0, watch: 1, alert: 2 };
  cur.level = rank[ev.level] > rank[cur.level] ? ev.level : cur.level;
  cur.events = [...cur.events, ev].slice(-MAX_EVENTS);
  fs.writeFileSync(file, JSON.stringify(cur, null, 2) + "\n", "utf8");
  prune(dir);
  return cur;
}

export function listStates(dir: string = tripStateDir()): TripState[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .map((n) => readState(path.join(dir, n)))
      .filter((s): s is TripState => !!s)
      .sort((a, b) => (a.events.at(-1)?.ts ?? "").localeCompare(b.events.at(-1)?.ts ?? ""));
  } catch {
    return [];
  }
}

/** Clear tripped sessions (all, or one). Files are moved to `cleared/`, not deleted, so the evidence is kept. */
export function clearStates(which?: { agent: string; session: string }, dir: string = tripStateDir()): string[] {
  const moved: string[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return moved;
  }
  const only = which ? path.basename(stateFile(which.agent, which.session, dir)) : null;
  const dest = path.join(dir, "cleared");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const n of names) {
    if (only && n !== only) continue;
    fs.mkdirSync(dest, { recursive: true });
    fs.renameSync(path.join(dir, n), path.join(dest, `${n.replace(/\.json$/, "")}.${stamp}.json`));
    moved.push(n);
  }
  return moved;
}
