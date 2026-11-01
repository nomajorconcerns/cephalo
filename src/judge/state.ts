import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cephaloDir } from "../rules.js";
import { requiredTags, normalizeTag, type ModelsConfig } from "../models/config.js";
import { ollamaStatus, type FetchLike } from "../models/ollama.js";

/* ------------------------------------------------------------------ model availability, checked now and then */

export interface ModelsCheck {
  t: number;
  host: string;
  reachable: boolean;
  /** Configured models Ollama does not have. */
  missing: string[];
  /** Why Ollama could not be reached. */
  error?: string;
  /** The model list this check was for; a changed config is checked again at once. */
  wanted?: string;
}

export const modelsCheckPath = () => path.join(cephaloDir(), "models-check.json");
const CHECK_EVERY_MS = 10 * 60 * 1000;

export function readModelsCheck(file: string = modelsCheckPath()): ModelsCheck | null {
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof c?.t === "number" && Array.isArray(c.missing) ? (c as ModelsCheck) : null;
  } catch {
    return null;
  }
}

/**
 * The startup check: which configured models does Ollama have? Cheap (one local request), so the hook runs it
 * at most every 10 minutes (or when the host or model list changed) and remembers the answer in a small file.
 * Returns the new result when it ran, null when the last one is still fresh. Never throws.
 */
export async function checkModelsIfStale(config: ModelsConfig, o: { file?: string; fetch?: FetchLike; now?: () => number } = {}): Promise<ModelsCheck | null> {
  const file = o.file ?? modelsCheckPath();
  const now = (o.now ?? Date.now)();
  const last = readModelsCheck(file);
  const wanted = requiredTags(config).map((r) => normalizeTag(r.tag)).sort().join(",");
  if (last && last.host === config.host && now - last.t < CHECK_EVERY_MS && last.wanted === wanted) return null;
  const s = await ollamaStatus({ host: config.host, timeoutMs: Math.min(2000, config.timeoutMs), fetch: o.fetch });
  const check: ModelsCheck = {
    t: now,
    host: config.host,
    reachable: s.reachable,
    missing: s.reachable ? requiredTags(config).filter((r) => !s.installed.some((i) => normalizeTag(i) === normalizeTag(r.tag))).map((r) => r.tag) : [],
    ...(s.error ? { error: s.error } : {}),
    wanted,
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(check), "utf8");
  } catch {
    /* only costs a repeat check */
  }
  return check;
}

/* ------------------------------------------------------------------ asks waiting for the user's answer */

export const asksDir = () => path.join(cephaloDir(), "asks");
const askFile = (dir: string, session: string | undefined, command: string) => path.join(dir, `${crypto.createHash("sha256").update(`${session ?? ""}\0${command}`).digest("hex").slice(0, 24)}.json`);

export interface PendingAsk {
  t: number;
  session?: string;
  command: string;
}

/** Remember that the user was asked about this command. */
export function recordAsk(a: { command: string; session?: string }, dir: string = asksDir(), now: number = Date.now()): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(askFile(dir, a.session, a.command), JSON.stringify({ t: now, session: a.session, command: a.command } satisfies PendingAsk), "utf8");
  } catch {
    /* the ask itself still happens; only the later "approved" note is lost */
  }
}

/** True (once) if the user had been asked about exactly this command in this session: the command ran, so they approved it. */
export function takeAsk(a: { command: string; session?: string }, dir: string = asksDir()): boolean {
  const f = askFile(dir, a.session, a.command);
  try {
    if (!fs.existsSync(f)) return false;
    fs.rmSync(f, { force: true });
    return true;
  } catch {
    return false;
  }
}

const STALE_ASK_MS = 15 * 60 * 1000;

/** Asks nobody ran within 15 minutes: the user said no, or walked away. Returned (and removed) so they can be logged. */
export function sweepAsks(dir: string = asksDir(), now: number = Date.now()): PendingAsk[] {
  const stale: PendingAsk[] = [];
  try {
    for (const n of fs.readdirSync(dir)) {
      const f = path.join(dir, n);
      try {
        const a = JSON.parse(fs.readFileSync(f, "utf8")) as PendingAsk;
        if (now - a.t > STALE_ASK_MS) {
          stale.push(a);
          fs.rmSync(f, { force: true });
        }
      } catch {
        fs.rmSync(f, { force: true });
      }
    }
  } catch {
    /* no asks directory yet */
  }
  return stale;
}
