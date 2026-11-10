/**
 * The seam between the free, MIT-licensed core and the optional paid package (@nomajorconcerns/cephalo-pro).
 *
 * This file holds no paid feature. It does four things: it keeps the license record, it talks to Polar's public
 * license-key API to activate, check and release a key, it finds the paid package where `cephalo pro activate` installed it,
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

/* ==================================================================================================================
 * POLAR SETTINGS: the only place to edit when connecting the Polar store. Nothing here is secret.
 *
 *  POLAR_ORG_ID           Polar dashboard > Settings (the organization ID, a UUID).
 *  POLAR_PRO_BENEFIT_ID   Polar dashboard > Products > Benefits > the "License Keys" benefit attached to the Pro product.
 *  POLAR_TEAM_BENEFIT_ID  the same, for the Team product.
 *
 * A key must belong to this organization and to one of these two benefits; the benefit decides the plan. While any of them
 * is still a REPLACE_ME placeholder, `cephalo pro activate` and `renew` refuse with a plain message and send nothing.
 * Sandbox (CEPHALO_POLAR_SANDBOX=1) is a separate Polar environment with its own IDs: set CEPHALO_POLAR_ORG_ID,
 * CEPHALO_POLAR_PRO_BENEFIT_ID and CEPHALO_POLAR_TEAM_BENEFIT_ID for it. Those variables are ignored outside sandbox mode.
 * ================================================================================================================== */
export const POLAR_ORG_ID = "888ef463-f98b-46bb-8b67-42ec0c1da73a";
export const POLAR_PRO_BENEFIT_ID = "1278cd12-4369-426e-b1eb-5b69e3f9bf36";
export const POLAR_TEAM_BENEFIT_ID = "652bac53-e3f8-405c-8f43-2adac4f34e6f";
/** Polar's customer-portal license-key endpoints. They need no access token and are meant to be called from a client. */
export const POLAR_API = "https://api.polar.sh/v1/customer-portal/license-keys";
export const POLAR_SANDBOX_API = "https://sandbox-api.polar.sh/v1/customer-portal/license-keys";

export const isPlaceholder = (id: string): boolean => !id || id.startsWith("REPLACE_ME");

/** The Polar organization, the two benefits, and the API base to use. */
export interface PolarIds {
  orgId: string;
  proBenefitId: string;
  teamBenefitId: string;
}
export interface PolarTarget extends PolarIds {
  api: string;
  sandbox: boolean;
}

/** Production by default; the sandbox, with IDs from the environment, when CEPHALO_POLAR_SANDBOX=1. */
export function polarTarget(env: Record<string, string | undefined> = process.env): PolarTarget {
  const sandbox = env.CEPHALO_POLAR_SANDBOX === "1";
  if (!sandbox) return { api: POLAR_API, sandbox, orgId: POLAR_ORG_ID, proBenefitId: POLAR_PRO_BENEFIT_ID, teamBenefitId: POLAR_TEAM_BENEFIT_ID };
  return {
    api: POLAR_SANDBOX_API,
    sandbox,
    orgId: env.CEPHALO_POLAR_ORG_ID?.trim() || POLAR_ORG_ID,
    proBenefitId: env.CEPHALO_POLAR_PRO_BENEFIT_ID?.trim() || POLAR_PRO_BENEFIT_ID,
    teamBenefitId: env.CEPHALO_POLAR_TEAM_BENEFIT_ID?.trim() || POLAR_TEAM_BENEFIT_ID,
  };
}

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
  /** Who issued the key. Records without it were made by Cephalo 0.2.0 with Lemon Squeezy, which is no longer used. */
  provider?: "polar";
  /** Activated against Polar's sandbox (CEPHALO_POLAR_SANDBOX=1); renew and deactivate must use the sandbox too. */
  sandbox?: boolean;
  tier: Tier;
  /** The Polar activation ID this machine holds (the field name is kept from 0.2.0). */
  instanceId: string;
  /** The activation label: this machine's name. */
  instanceName: string;
  /** Last four characters of the key, so `status` can say which key it is. The key itself is not stored. */
  keyHint: string;
  activatedAt: string;
  validatedAt: string;
  /** The key's expiry date reported by Polar, if any. */
  expiresAt?: string;
  /** The customer's email as Polar reports it; shown in `status` only. */
  email?: string;
}

/** A record left by Cephalo 0.2.0's Lemon Squeezy licensing. It still reads, but turns nothing on. */
export const isLegacyRecord = (rec: LicenseRecord): boolean => rec.provider !== "polar";
export const LEGACY_MESSAGE = "This license was activated with Lemon Squeezy, which Cephalo no longer uses. Re-activate with a Polar key: cephalo pro activate";

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
  | { state: "expired"; license: LicenseRecord }
  | { state: "legacy"; license: LicenseRecord };

export function licenseState(rec: LicenseRecord | null, now: Date = new Date()): LicenseState {
  if (!rec) return { state: "none" };
  if (isLegacyRecord(rec)) return { state: "legacy", license: rec };
  if (rec.expiresAt) {
    const end = Date.parse(rec.expiresAt);
    if (Number.isFinite(end) && end < now.getTime()) return { state: "expired", license: rec };
  }
  const checked = Date.parse(rec.validatedAt);
  const ageDays = Number.isFinite(checked) ? (now.getTime() - checked) / 86_400_000 : Infinity;
  if (ageDays > LICENSE_VALID_DAYS) return { state: "stale", license: rec, daysAgo: Math.floor(ageDays) };
  return { state: "active", license: rec, daysLeft: Math.max(0, Math.ceil(LICENSE_VALID_DAYS - ageDays)) };
}

/* ------------------------------------------------------------------ Polar license-key API */

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** The parts of Polar's license key object Cephalo reads (activate's `license_key`, and validate's reply). */
interface PolarKey {
  organization_id?: string;
  benefit_id?: string;
  status?: string;
  expires_at?: string | null;
  limit_activations?: number | null;
  validations?: number;
  customer?: { email?: string | null } | null;
  activation?: { id?: string } | null;
}
interface PolarActivation {
  id?: string;
  label?: string;
  license_key?: PolarKey;
}

type CallResult = { ok: true; status: number; body: unknown } | { ok: false; status: number; error: string };

/** One POST with a JSON body. Turns every failure into a plain sentence; `status` is 0 when the server was not reached. */
async function polarCall(fetchFn: Fetch, base: string, action: "activate" | "validate" | "deactivate", body: Record<string, string>): Promise<CallResult> {
  let res;
  try {
    res = await fetchFn(`${base}/${action}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, status: 0, error: `could not reach the license server (${(e as Error).message}). Check your connection and try again.` };
  }
  if (res.status === 204) return { ok: true, status: 204, body: null };
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    if (res.ok) return { ok: false, status: res.status, error: `the license server sent a reply Cephalo could not read (HTTP ${res.status}).` };
    parsed = undefined;
  }
  if (res.ok) return { ok: true, status: res.status, body: parsed };
  const detail = (parsed as { detail?: unknown } | undefined)?.detail;
  // Polar's own words, ending in a full stop so a sentence of ours can follow.
  const said = typeof detail === "string" && detail.trim() ? detail.trim().replace(/([^.!?])$/, "$1.") : "";
  switch (res.status) {
    case 404:
      return { ok: false, status: 404, error: said ? `Polar said: ${said}` : "Polar does not know this key." };
    case 403:
      return { ok: false, status: 403, error: said ? `Polar refused: ${said}` : "Polar refused this key." };
    case 422:
      return { ok: false, status: 422, error: "Polar could not read the request. Check that you copied the whole key." };
    case 429:
      return { ok: false, status: 429, error: "Polar is limiting license checks right now. Wait a few seconds and try again." };
    default:
      return { ok: false, status: res.status, error: `the license server answered HTTP ${res.status}${said ? `: ${said}` : ""}.` };
  }
}

/** Pro or Team from the benefit the key was issued under; null if it is neither (then the key is not for Cephalo). */
export function tierFromBenefit(benefitId: string | undefined, ids: PolarIds): Tier | null {
  if (!benefitId || isPlaceholder(benefitId)) return null;
  if (benefitId === ids.teamBenefitId) return "Team";
  if (benefitId === ids.proBenefitId) return "Pro";
  return null;
}

/** Why a key Polar answered for is still not one Cephalo accepts, or null if it is fine. */
function refusal(k: PolarKey | undefined, ids: PolarIds): string | null {
  if (!k) return "the license server sent no license details.";
  if (k.organization_id !== ids.orgId) return "that key was issued by another Polar seller, not for Cephalo.";
  if (k.status !== "granted") return `the license is ${k.status ?? "not active"} (cancelled, refunded or disabled).`;
  if (!tierFromBenefit(k.benefit_id, ids)) return "that key is valid, but it is not a Cephalo Pro or Team key.";
  return null;
}

export interface LicenseOps {
  fetch?: Fetch;
  /** API base, for tests; Polar's (or its sandbox, with CEPHALO_POLAR_SANDBOX=1) by default. */
  api?: string;
  /** Organization and benefit IDs, for tests; the POLAR SETTINGS above (or the sandbox variables) by default. */
  polar?: PolarIds;
  env?: Record<string, string | undefined>;
  now?: Date;
  hostname?: string;
}

const hint = (key: string) => key.trim().slice(-4);
const defaultFetch: Fetch = (url, init) => fetch(url, init) as ReturnType<Fetch>;

function target(o: LicenseOps): PolarTarget {
  const t = polarTarget(o.env ?? process.env);
  return { ...t, ...(o.polar ?? {}), api: o.api ?? t.api };
}
const NOT_CONFIGURED =
  "this copy of Cephalo has no Polar store set up yet (the organization and benefit IDs are placeholders), so it cannot check a key. Nothing was sent.";
const notConfigured = (t: PolarIds, needBenefits = true) => isPlaceholder(t.orgId) || (needBenefits && (isPlaceholder(t.proBenefitId) || isPlaceholder(t.teamBenefitId)));

export type OpResult = { ok: true; record: LicenseRecord } | { ok: false; error: string };

/**
 * Activate the key for this machine (label: the hostname), then validate that activation and refuse unless the key is
 * granted, belongs to our organization and to the Pro or Team benefit. A key that is refused after it was activated has
 * its activation given back, so a seat is never left used up.
 */
export async function activateLicense(key: string, o: LicenseOps = {}): Promise<OpResult> {
  const k = key.trim();
  if (!k) return { ok: false, error: "no license key given." };
  const t = target(o);
  if (notConfigured(t)) return { ok: false, error: NOT_CONFIGURED };
  const f = o.fetch ?? defaultFetch;
  const label = `${o.hostname ?? os.hostname()}`.slice(0, 60) || "cephalo";
  const a = await polarCall(f, t.api, "activate", { key: k, organization_id: t.orgId, label });
  if (!a.ok) {
    const limit = a.status === 403 ? " If every seat of this key is in use, run `cephalo pro deactivate` on a machine you no longer use, then try again." : "";
    return { ok: false, error: a.error + limit };
  }
  const act = a.body as PolarActivation | null;
  if (!act?.id) return { ok: false, error: "the license server did not activate this key." };
  const giveBack = async (why: string): Promise<OpResult> => {
    const d = await polarCall(f, t.api, "deactivate", { key: k, organization_id: t.orgId, activation_id: act.id! });
    return { ok: false, error: d.ok ? why : `${why} (The activation could not be given back: ${d.error})` };
  };
  const v = await polarCall(f, t.api, "validate", { key: k, organization_id: t.orgId, activation_id: act.id });
  if (!v.ok) return giveBack(`the key was activated but did not pass the check that follows: ${v.error}`);
  const lk = v.body as PolarKey | null;
  const no = refusal(lk ?? undefined, t);
  if (no) return giveBack(no);
  const now = (o.now ?? new Date()).toISOString();
  const email = lk?.customer?.email;
  return {
    ok: true,
    record: {
      version: 1,
      provider: "polar",
      ...(t.sandbox ? { sandbox: true } : {}),
      tier: tierFromBenefit(lk!.benefit_id, t)!,
      instanceId: act.id,
      instanceName: act.label ?? label,
      keyHint: hint(k),
      activatedAt: now,
      validatedAt: now,
      ...(lk?.expires_at ? { expiresAt: lk.expires_at } : {}),
      ...(typeof email === "string" && email ? { email } : {}),
    },
  };
}

/** Records made against the sandbox are renewed and released against the sandbox, and the other way round. */
function sameEnvironment(rec: LicenseRecord, t: PolarTarget): string | null {
  if (isLegacyRecord(rec)) return LEGACY_MESSAGE;
  if (Boolean(rec.sandbox) !== t.sandbox) return rec.sandbox ? "this license was activated against Polar's sandbox. Set CEPHALO_POLAR_SANDBOX=1 to use it." : "this license was activated against Polar itself, not the sandbox. Unset CEPHALO_POLAR_SANDBOX to use it.";
  return null;
}

/**
 * Ask Polar whether this machine's activation is still good. `key` is needed again because it is not stored. Polar answers
 * 404 for a key that is revoked, disabled or expired, so that, like any status other than granted, ends the license.
 */
export async function validateLicense(rec: LicenseRecord, key: string, o: LicenseOps = {}): Promise<OpResult> {
  const t = target(o);
  const env = sameEnvironment(rec, t);
  if (env) return { ok: false, error: env };
  if (notConfigured(t)) return { ok: false, error: NOT_CONFIGURED };
  const v = await polarCall(o.fetch ?? defaultFetch, t.api, "validate", { key: key.trim(), organization_id: t.orgId, activation_id: rec.instanceId });
  if (!v.ok) {
    if (v.status === 404) return { ok: false, error: `the license has ended: it was revoked, disabled or expired (for example, the subscription was cancelled), or this machine's activation was removed. ${v.error}` };
    return v;
  }
  const lk = v.body as PolarKey | null;
  const no = refusal(lk ?? undefined, t);
  if (no) return { ok: false, error: no };
  const { expiresAt: _old, ...rest } = rec;
  void _old;
  return {
    ok: true,
    record: { ...rest, tier: tierFromBenefit(lk!.benefit_id, t)!, validatedAt: (o.now ?? new Date()).toISOString(), ...(lk?.expires_at ? { expiresAt: lk.expires_at } : {}) },
  };
}

/** Give this machine's seat back. */
export async function deactivateLicense(rec: LicenseRecord, key: string, o: LicenseOps = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  const t = target(o);
  const env = sameEnvironment(rec, t);
  if (env) return { ok: false, error: env };
  if (notConfigured(t, false)) return { ok: false, error: NOT_CONFIGURED };
  const r = await polarCall(o.fetch ?? defaultFetch, t.api, "deactivate", { key: key.trim(), organization_id: t.orgId, activation_id: rec.instanceId });
  if (!r.ok) return { ok: false, error: r.status === 404 ? `Polar has no such activation for this key (${r.error.replace(/^Polar said: /, "").replace(/\.$/, "")}).` : r.error };
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
  | { ok: false; reason: "no-license" | "legacy" | "stale" | "expired" | "not-installed" | "incompatible" | "broken"; detail?: string };

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
  if (st.state === "legacy") return { ok: false, reason: "legacy" };
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
    case "legacy":
      return [head, LEGACY_MESSAGE];
    case "stale":
      return [head, `Your license was last checked ${loaded.detail?.replace("last checked ", "")}. Run: cephalo pro renew`];
    case "expired":
      return [head, "Your license has expired. Renew the subscription, then run: cephalo pro renew"];
    case "not-installed":
      return [head, "Your license is active but the Pro package is not installed on this machine.", "Install the cephalo-pro-0.2.0.tgz download from your Polar purchase: npm install -g ./cephalo-pro-0.2.0.tgz"];
    case "incompatible":
      return [head, `The installed Pro package does not match this Cephalo (${loaded.detail}). Download the current cephalo-pro .tgz from your Polar purchase and install it again.`];
    default:
      return [head, `The installed Pro package could not be loaded (${loaded.detail ?? "unknown error"}). Install the .tgz from your Polar purchase again.`];
  }
}
