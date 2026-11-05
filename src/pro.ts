/**
 * The seam between the free, MIT-licensed core and the optional paid package (@nomajorconcerns/cephalo-pro).
 *
 * This file holds no paid feature. It does four things: it keeps the license record, it talks to the Lemon Squeezy
 * license API to activate, check and release a key, it finds the paid package where `cephalo pro activate` installed it,
 * and it says plainly what is missing when a paid command is run without it.
 *
 * Rules the seam keeps:
 *  - The package is loaded from where Cephalo itself is installed (the sibling folder in the same node_modules, which is where
 *    a global install of the downloaded .tgz puts it) or from ~/.cephalo/pro (the `pro install` command), never from the
 *    current directory, so a repository cannot plant its own copy and have it run. Agents cannot write to either place.
 *  - Loading is synchronous and does no network I/O, because the hook must stay fast. The license is checked against the
 *    server only by `cephalo pro activate | renew | status`.
 *  - The package must speak this plugin API version. Anything else is treated as not installed, with a reason.
 *  - Nothing here removes or limits a feature that existed in 0.1.1. Those stay free.
 *
 * Honest limit: this is client-side. Someone who edits their own files can run the paid package without paying for it.
 * The license check keeps honest customers honest, it is not copy protection.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cephaloDir } from "./rules.js";

export const PRO_PACKAGE = "@nomajorconcerns/cephalo-pro";
export const PLUGIN_API_VERSION = 1;
export const PRICING_URL = "https://nomajorconcerns.github.io/cephalo/#pricing";
export const LICENSE_API = "https://api.lemonsqueezy.com/v1/licenses";

/**
 * The Lemon Squeezy store and the two products a key must belong to. A key for any other store or product is refused, so a key
 * bought for something else cannot unlock Cephalo Pro. The product decides the plan.
 */
export const LS_STORE_ID = 513818;
export const LS_PRO_PRODUCT_ID = 1504334;
export const LS_TEAM_PRODUCT_ID = 1504325;

/** A license is trusted this long after the server last said it was valid. Then `cephalo pro renew` is needed. */
export const LICENSE_VALID_DAYS = 35;

export type Tier = "Pro" | "Team";

/** What the paid commands are, and the plan that includes them. Free commands are never listed here. */
export const PAID_COMMANDS: Readonly<Record<string, string>> = {
  audit: "Pro",
  bench: "Pro",
  egress: "Pro",
};

export interface LicenseRecord {
  version: 1;
  tier: Tier;
  /** The Lemon Squeezy activation this machine holds. */
  instanceId: string;
  instanceName: string;
  /** Last four characters of the key, so `status` can say which key it is. The key itself is not stored. */
  keyHint: string;
  activatedAt: string;
  validatedAt: string;
  /** Subscription end date reported by the server, if any. */
  expiresAt?: string;
  /** The customer's email as Lemon Squeezy reports it; shown in `status` only. */
  email?: string;
}

export const licensePath = (dir: string = cephaloDir()): string => path.join(dir, "license.json");
export const proDir = (dir: string = cephaloDir()): string => path.join(dir, "pro");

export function readLicense(file: string = licensePath()): LicenseRecord | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (j && j.version === 1 && (j.tier === "Pro" || j.tier === "Team") && typeof j.instanceId === "string" && typeof j.validatedAt === "string") return j as LicenseRecord;
  } catch {
    /* none, or unreadable */
  }
  return null;
}

export function writeLicense(rec: LicenseRecord, file: string = licensePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rec, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

export type LicenseState =
  | { state: "none" }
  | { state: "active"; license: LicenseRecord; daysLeft: number }
  | { state: "stale"; license: LicenseRecord; daysAgo: number }
  | { state: "expired"; license: LicenseRecord };

export function licenseState(rec: LicenseRecord | null, now: Date = new Date()): LicenseState {
  if (!rec) return { state: "none" };
  if (rec.expiresAt) {
    const end = Date.parse(rec.expiresAt);
    if (Number.isFinite(end) && end < now.getTime()) return { state: "expired", license: rec };
  }
  const checked = Date.parse(rec.validatedAt);
  const ageDays = Number.isFinite(checked) ? (now.getTime() - checked) / 86_400_000 : Infinity;
  if (ageDays > LICENSE_VALID_DAYS) return { state: "stale", license: rec, daysAgo: Math.floor(ageDays) };
  return { state: "active", license: rec, daysLeft: Math.max(0, Math.ceil(LICENSE_VALID_DAYS - ageDays)) };
}

/* ------------------------------------------------------------------ Lemon Squeezy license API */

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface LsMeta {
  store_id?: number;
  product_id?: number;
  variant_name?: string;
  customer_email?: string;
}
interface LsLicenseKey {
  status?: string;
  key?: string;
  expires_at?: string | null;
}
interface LsReply {
  activated?: boolean;
  valid?: boolean;
  deactivated?: boolean;
  error?: string | null;
  license_key?: LsLicenseKey;
  instance?: { id?: string; name?: string } | null;
  meta?: LsMeta;
}

async function lsCall(fetchFn: Fetch, base: string, action: "activate" | "validate" | "deactivate", fields: Record<string, string>): Promise<{ ok: true; reply: LsReply } | { ok: false; error: string }> {
  let res;
  try {
    res = await fetchFn(`${base}/${action}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
  } catch (e) {
    return { ok: false, error: `could not reach the license server (${(e as Error).message}). Check your connection and try again.` };
  }
  let reply: LsReply;
  try {
    reply = (await res.json()) as LsReply;
  } catch {
    return { ok: false, error: `the license server sent a reply Cephalo could not read (HTTP ${res.status}).` };
  }
  return { ok: true, reply };
}

/** Pro or Team from the store and product the key was sold under; null if it is neither (then the key is not for Cephalo). */
export function tierFromMeta(meta: LsMeta | undefined): Tier | null {
  if (meta?.store_id !== LS_STORE_ID) return null;
  if (meta.product_id === LS_TEAM_PRODUCT_ID) return "Team";
  if (meta.product_id === LS_PRO_PRODUCT_ID) return "Pro";
  return null;
}

export interface LicenseOps {
  fetch?: Fetch;
  /** API base, for tests; the real one by default. */
  api?: string;
  now?: Date;
  hostname?: string;
}

const hint = (key: string) => key.trim().slice(-4);
const defaultFetch: Fetch = (url, init) => fetch(url, init) as ReturnType<Fetch>;

export type OpResult = { ok: true; record: LicenseRecord } | { ok: false; error: string };

export async function activateLicense(key: string, o: LicenseOps = {}): Promise<OpResult> {
  const k = key.trim();
  if (!k) return { ok: false, error: "no license key given." };
  const name = `${o.hostname ?? os.hostname()}`.slice(0, 60) || "cephalo";
  const r = await lsCall(o.fetch ?? defaultFetch, o.api ?? LICENSE_API, "activate", { license_key: k, instance_name: name });
  if (!r.ok) return r;
  const a = r.reply;
  if (!a.activated || !a.instance?.id) return { ok: false, error: a.error ? `the license server said: ${a.error}` : "the license server did not activate this key." };
  const tier = tierFromMeta(a.meta);
  if (!tier) {
    // the key is valid but not for us: give the seat back rather than leave it used up
    await lsCall(o.fetch ?? defaultFetch, o.api ?? LICENSE_API, "deactivate", { license_key: k, instance_id: a.instance.id });
    return { ok: false, error: "that key is valid, but it is not a Cephalo Pro or Team key." };
  }
  const now = (o.now ?? new Date()).toISOString();
  return {
    ok: true,
    record: {
      version: 1,
      tier,
      instanceId: a.instance.id,
      instanceName: a.instance.name ?? name,
      keyHint: hint(k),
      activatedAt: now,
      validatedAt: now,
      ...(a.license_key?.expires_at ? { expiresAt: a.license_key.expires_at } : {}),
      ...(a.meta?.customer_email ? { email: a.meta.customer_email } : {}),
    },
  };
}

/** Ask the server whether this machine's activation is still good. `key` is needed again because it is not stored. */
export async function validateLicense(rec: LicenseRecord, key: string, o: LicenseOps = {}): Promise<OpResult> {
  const r = await lsCall(o.fetch ?? defaultFetch, o.api ?? LICENSE_API, "validate", { license_key: key.trim(), instance_id: rec.instanceId });
  if (!r.ok) return r;
  const v = r.reply;
  if (!v.valid) return { ok: false, error: v.error ? `the license server said: ${v.error}` : `the license is ${v.license_key?.status ?? "not valid"}.` };
  const tier = tierFromMeta(v.meta) ?? rec.tier;
  return {
    ok: true,
    record: { ...rec, tier, validatedAt: (o.now ?? new Date()).toISOString(), ...(v.license_key?.expires_at ? { expiresAt: v.license_key.expires_at } : {}) },
  };
}

export async function deactivateLicense(rec: LicenseRecord, key: string, o: LicenseOps = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await lsCall(o.fetch ?? defaultFetch, o.api ?? LICENSE_API, "deactivate", { license_key: key.trim(), instance_id: rec.instanceId });
  if (!r.ok) return r;
  if (!r.reply.deactivated) return { ok: false, error: r.reply.error ? `the license server said: ${r.reply.error}` : "the license server did not release this machine." };
  return { ok: true };
}

/* ------------------------------------------------------------------ the paid package */

/** What the core hands to a paid command. Plain data and functions, so the package does not import the core. */
export interface ProContext {
  version: string;
  tier: Tier;
  /** ~/.cephalo */
  dir: string;
  auditFile: string;
  /** Run one shell command through the rules in force and report what would happen, without running it or writing the log. */
  evaluate(command: string, opts?: { defaults?: boolean }): { decision: "allow" | "block" | "ask"; rule?: string };
  /** The CLI's color theme (identity functions when color is off). */
  painter: { role(r: string, text: string): string; label(kind: "allow" | "block" | "ask", text?: string): string; level: number };
  out(line: string): void;
  err(line: string): void;
}
export type ProCommand = (args: string[], ctx: ProContext) => Promise<number> | number;

export interface EgressInput {
  /** The raw shell command and every command found inside it (see analyze.ts). */
  commands?: string[];
  /** The command could not be read cleanly, so its parts may be incomplete. */
  unreadable?: boolean;
  /** URLs a web tool was asked to fetch. */
  urls?: string[];
  /** The parameters of an MCP tool call. */
  params?: unknown;
}
export interface EgressVerdict {
  decision: "allow" | "block" | "ask";
  /** One plain sentence for the person and the agent. */
  reason: string;
  hosts: string[];
}

export interface ProRuntime {
  apiVersion: number;
  tier: Tier;
  /** Checks where a call would send data. Absent or returning null means "no opinion". */
  egress?: { check(input: EgressInput, opts?: { file?: string }): EgressVerdict | null };
  /** Writes one audit line chained to the previous one. `line` is the finished, redacted JSON text without a newline. */
  audit?: { append(file: string, line: string): void };
  commands: Record<string, ProCommand>;
}

export type Loaded =
  | { ok: true; runtime: ProRuntime }
  | { ok: false; reason: "no-license" | "stale" | "expired" | "not-installed" | "incompatible" | "broken"; detail?: string };

export interface LoadOptions {
  dir?: string;
  /** Replaces the places the package is looked for (tests). */
  roots?: string[];
  now?: Date;
  /** Replaces the file loader (tests). Given the absolute path of the package entry. */
  requireFn?: (entry: string) => unknown;
}

/**
 * Where the paid package may be installed, in the order they are tried:
 *  1. next to Cephalo itself, when Cephalo is installed as @nomajorconcerns/cephalo in a node_modules folder. This is where
 *     `npm install -g ./cephalo-pro-0.2.0.tgz` puts it. (A clone linked with `npm link` has no such sibling.)
 *  2. ~/.cephalo/pro, where `cephalo pro install <file>` puts it.
 */
export function proRoots(dir: string = cephaloDir()): string[] {
  const roots: string[] = [];
  const self = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const scope = path.dirname(self);
  if (path.basename(self) === "cephalo" && path.basename(scope) === "@nomajorconcerns") roots.push(path.join(scope, "cephalo-pro"));
  roots.push(path.join(proDir(dir), "node_modules", ...PRO_PACKAGE.split("/")));
  return roots;
}

/** The entry file of the installed package, or null. */
export function proEntry(dir: string = cephaloDir(), roots: string[] = proRoots(dir)): string | null {
  for (const pkgDir of roots) {
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
      if (pj.name !== PRO_PACKAGE) continue;
      const main = typeof pj.main === "string" ? pj.main : "index.js";
      const entry = path.join(pkgDir, main);
      if (fs.existsSync(entry)) return entry;
    } catch {
      /* not here */
    }
  }
  return null;
}

/**
 * Load the paid package if there is a current license and the package is installed and compatible. Synchronous, no
 * network, never throws. This runs inside the hook, so the first thing it does is stop if there is no license file.
 */
export function loadPro(o: LoadOptions = {}): Loaded {
  const dir = o.dir ?? cephaloDir();
  const rec = readLicense(licensePath(dir));
  const st = licenseState(rec, o.now);
  if (st.state === "none") return { ok: false, reason: "no-license" };
  if (st.state === "stale") return { ok: false, reason: "stale", detail: `last checked ${st.daysAgo} days ago` };
  if (st.state === "expired") return { ok: false, reason: "expired", detail: rec?.expiresAt };
  const entry = proEntry(dir, o.roots);
  if (!entry) return { ok: false, reason: "not-installed" };
  let mod: unknown;
  try {
    mod = (o.requireFn ?? ((e: string) => createRequire(import.meta.url)(e)))(entry);
  } catch (e) {
    return { ok: false, reason: "broken", detail: (e as Error)?.message ?? String(e) };
  }
  const m = mod as Partial<ProRuntime> | null;
  if (!m || typeof m !== "object" || typeof m.commands !== "object" || m.commands === null) return { ok: false, reason: "broken", detail: "the package does not export a commands table" };
  if (m.apiVersion !== PLUGIN_API_VERSION) return { ok: false, reason: "incompatible", detail: `it speaks plugin API ${String(m.apiVersion)}, this Cephalo speaks ${PLUGIN_API_VERSION}` };
  return { ok: true, runtime: { ...(m as ProRuntime), tier: st.license.tier } };
}

/** What to print when a paid command is run without a working paid package. Plain text. */
export function notAvailableMessage(cmd: string, loaded: Extract<Loaded, { ok: false }>): string[] {
  const plan = PAID_COMMANDS[cmd] ?? "Pro";
  const head = `"cephalo ${cmd}" is part of Cephalo ${plan} (also in Team).`;
  switch (loaded.reason) {
    case "no-license":
      return [head, `Plans and prices: ${PRICING_URL}`, "Already bought it? Run: cephalo pro activate", "Everything that was in Cephalo 0.1.1 is free and keeps working."];
    case "stale":
      return [head, `Your license was last checked ${loaded.detail?.replace("last checked ", "")}. Run: cephalo pro renew`];
    case "expired":
      return [head, "Your license has expired. Renew the subscription, then run: cephalo pro renew"];
    case "not-installed":
      return [head, "Your license is active but the Pro package is not installed on this machine.", "Install the cephalo-pro-0.2.0.tgz that came with your Lemon Squeezy order: npm install -g ./cephalo-pro-0.2.0.tgz"];
    case "incompatible":
      return [head, `The installed Pro package does not match this Cephalo (${loaded.detail}). Download the current cephalo-pro .tgz from your Lemon Squeezy order and install it again.`];
    default:
      return [head, `The installed Pro package could not be loaded (${loaded.detail ?? "unknown error"}). Install the .tgz from your Lemon Squeezy order again.`];
  }
}
