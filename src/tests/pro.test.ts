import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendAudit, readAudit } from "../audit.js";
import { evaluate } from "../engine.js";
import { runHook } from "../hooks.js";
import { getPlatform } from "../platform.js";
import { SYSTEM_RULES, installGuardRules } from "../platform-rules.js";
import {
  LEGACY_MESSAGE,
  LICENSE_VALID_DAYS,
  PAID_COMMANDS,
  PLUGIN_API_VERSION,
  POLAR_API,
  POLAR_ORG_ID,
  POLAR_PRO_BENEFIT_ID,
  POLAR_SANDBOX_API,
  POLAR_TEAM_BENEFIT_ID,
  activateLicense,
  deactivateLicense,
  isPlaceholder,
  licensePath,
  licenseState,
  loadPro,
  notAvailableMessage,
  polarTarget,
  proEntry,
  proRoots,
  readLicense,
  tierFromBenefit,
  validateLicense,
  writeLicense,
  type EgressInput,
  type Fetch,
  type LicenseRecord,
  type ProRuntime,
} from "../pro.js";
import { PRO_USAGE, installProFile, proCommand } from "../procmd.js";

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));
const tmp = (n = "pro") => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `cephalo-${n}-`)));
const NOW = new Date("2026-11-10T18:00:00.000Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();
const ACT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const record = (o: Partial<LicenseRecord> = {}): LicenseRecord => ({ version: 1, provider: "polar", tier: "Pro", instanceId: ACT, instanceName: "laptop", keyHint: "4D51", activatedAt: days(0), validatedAt: days(0), ...o });
/** What Cephalo 0.2.0 wrote with Lemon Squeezy: the same shape, no provider. */
const legacyRecord = (): LicenseRecord => ({ version: 1, tier: "Pro", instanceId: "inst-1", instanceName: "laptop", keyHint: "4d51", activatedAt: days(0), validatedAt: days(0) });
const KEY = "38B1460A-5104-4067-A91D-77B872934D51";

// Test IDs in place of the real Polar organization and benefits (which are placeholders in the source until the store is set up).
const ORG = "0a0a0a0a-0000-4000-8000-000000000001";
const PRO_B = "0b0b0b0b-0000-4000-8000-000000000002";
const TEAM_B = "0c0c0c0c-0000-4000-8000-000000000003";
const IDS = { orgId: ORG, proBenefitId: PRO_B, teamBenefitId: TEAM_B };

type Action = "activate" | "validate" | "deactivate";
type Reply = { status: number; body?: unknown };
const ok = (body: unknown): Reply => ({ status: 200, body });
const err = (status: number, detail?: string): Reply => ({ status, body: detail === undefined ? undefined : { error: status === 403 ? "NotPermitted" : "ResourceNotFound", detail } });

/** A mock of Polar's customer-portal license-key API. Records every call (with its parsed JSON body); never touches the network. */
function mockApi(handlers: Partial<Record<Action, (body: Record<string, string>) => Reply>>) {
  const calls: Array<{ action: string; body: Record<string, string>; url: string }> = [];
  const fetch: Fetch = async (url, init) => {
    const action = url.split("/").pop()!;
    const body = JSON.parse(init.body) as Record<string, string>;
    calls.push({ action, body, url });
    assert.equal(init.method, "POST");
    assert.equal(init.headers["Content-Type"], "application/json");
    assert.ok(!Object.keys(init.headers).some((h) => /authorization/i.test(h)), "these endpoints take no token, and none is sent");
    const h = handlers[action as Action];
    if (!h) throw new Error(`unexpected call to ${action}`);
    const r = h(body);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => (r.body === undefined ? Promise.reject(new SyntaxError("no body")) : r.body) };
  };
  return { fetch, calls };
}
/** Polar's license key object, as activate (nested) and validate (top level) return it. */
const lkey = (o: Record<string, unknown> = {}) => ({ id: "lk-1", organization_id: ORG, customer_id: "cu-1", customer: { email: "a@example.com" }, benefit_id: PRO_B, key: KEY, display_key: "****-4D51", status: "granted", limit_activations: 3, usage: 0, limit_usage: null, validations: 1, last_validated_at: NOW.toISOString(), expires_at: null, activation: { id: ACT, label: "laptop" }, ...o });
const goodActivate = (o: Record<string, unknown> = {}) => () => ok({ id: ACT, license_key_id: "lk-1", label: "laptop", meta: {}, created_at: NOW.toISOString(), modified_at: null, license_key: lkey(o) });
const goodValidate = (o: Record<string, unknown> = {}) => () => ok(lkey(o));
const released = () => ({ status: 204 });
/** A Polar that accepts the key; `o` changes the license key it reports. */
const polar = (o: Record<string, unknown> = {}) => mockApi({ activate: goodActivate(o), validate: goodValidate(o), deactivate: released });
const ops = (f: Fetch, more: object = {}) => ({ fetch: f, polar: IDS, now: NOW, hostname: "laptop", env: {}, ...more });

/* ------------------------------------------------------------------ license record and state */

test("the license record round-trips, holds no key, and bad files read as no license", () => {
  const dir = tmp();
  const file = licensePath(dir);
  assert.equal(readLicense(file), null);
  writeLicense(record(), file);
  assert.deepEqual(readLicense(file), record());
  assert.ok(!fs.readFileSync(file, "utf8").includes(KEY));
  for (const bad of ["", "{ nope", "[]", JSON.stringify({ version: 2 }), JSON.stringify({ ...record(), tier: "Free" }), JSON.stringify({ ...record(), instanceId: 5 })]) {
    fs.writeFileSync(file, bad);
    assert.equal(readLicense(file), null, bad);
  }
});

test("license state: active for 35 days after the last check, then stale; expired when the subscription ended", () => {
  assert.deepEqual(licenseState(null, NOW), { state: "none" });
  const fresh = licenseState(record({ validatedAt: days(0) }), NOW);
  assert.equal(fresh.state, "active");
  assert.equal(fresh.state === "active" && fresh.daysLeft, LICENSE_VALID_DAYS);
  assert.equal(licenseState(record({ validatedAt: days(-34) }), NOW).state, "active");
  const stale = licenseState(record({ validatedAt: days(-36) }), NOW);
  assert.equal(stale.state, "stale");
  assert.equal(stale.state === "stale" && stale.daysAgo, 36);
  assert.equal(licenseState(record({ expiresAt: days(-1) }), NOW).state, "expired");
  assert.equal(licenseState(record({ expiresAt: days(10) }), NOW).state, "active");
  assert.equal(licenseState(record({ validatedAt: "garbage" }), NOW).state, "stale", "an unreadable date is not trusted");
});

test("a Lemon Squeezy record from 0.2.0 still reads, turns nothing on, and says to re-activate with a Polar key", () => {
  const dir = tmp("legacy");
  fs.writeFileSync(licensePath(dir), JSON.stringify(legacyRecord()));
  const rec = readLicense(licensePath(dir));
  assert.ok(rec, "it is not treated as a broken file");
  assert.equal(licenseState(rec, NOW).state, "legacy");
  assert.deepEqual(loadPro({ dir, now: NOW }), { ok: false, reason: "legacy" });
  assert.match(notAvailableMessage("bench", { ok: false, reason: "legacy" }).join("\n"), /re-activate with a Polar key/i);
  assert.match(LEGACY_MESSAGE, /Lemon Squeezy, which Cephalo no longer uses/);
});

test("the plan comes from the Polar benefit the key was issued under; the shipped IDs are placeholders until the store is set up", () => {
  for (const id of [POLAR_ORG_ID, POLAR_PRO_BENEFIT_ID, POLAR_TEAM_BENEFIT_ID]) assert.ok(isPlaceholder(id), `${id} is a REPLACE_ME placeholder`);
  assert.equal(tierFromBenefit(PRO_B, IDS), "Pro");
  assert.equal(tierFromBenefit(TEAM_B, IDS), "Team");
  assert.equal(tierFromBenefit("0d0d0d0d-0000-4000-8000-000000000004", IDS), null, "some other benefit");
  assert.equal(tierFromBenefit(undefined, IDS), null);
  assert.equal(tierFromBenefit(POLAR_PRO_BENEFIT_ID, { orgId: ORG, proBenefitId: POLAR_PRO_BENEFIT_ID, teamBenefitId: TEAM_B }), null, "a placeholder never matches");
  assert.deepEqual(polarTarget({}), { api: POLAR_API, sandbox: false, orgId: POLAR_ORG_ID, proBenefitId: POLAR_PRO_BENEFIT_ID, teamBenefitId: POLAR_TEAM_BENEFIT_ID });
  assert.equal(POLAR_API, "https://api.polar.sh/v1/customer-portal/license-keys");
  assert.equal(POLAR_SANDBOX_API, "https://sandbox-api.polar.sh/v1/customer-portal/license-keys");
  assert.equal(polarTarget({ CEPHALO_POLAR_ORG_ID: ORG }).orgId, POLAR_ORG_ID, "the ID variables are ignored outside sandbox mode");
});

/* ------------------------------------------------------------------ the license API client */

test("activate: activates with the key, organization and machine name, validates that activation, and returns a record without the key", async () => {
  const api = polar();
  const r = await activateLicense(`  ${KEY}  `, ops(api.fetch));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(api.calls.map((c) => c.action), ["activate", "validate"]);
  assert.equal(api.calls[0]!.url, "https://api.polar.sh/v1/customer-portal/license-keys/activate");
  assert.deepEqual(api.calls[0]!.body, { key: KEY, organization_id: ORG, label: "laptop" });
  assert.equal(api.calls[1]!.url, "https://api.polar.sh/v1/customer-portal/license-keys/validate");
  assert.deepEqual(api.calls[1]!.body, { key: KEY, organization_id: ORG, activation_id: ACT });
  if (r.ok) {
    assert.deepEqual(r.record, record({ activatedAt: NOW.toISOString(), validatedAt: NOW.toISOString(), email: "a@example.com" }));
    assert.equal(r.record.provider, "polar");
    assert.ok(!JSON.stringify(r.record).includes(KEY));
  }
  const team = await activateLicense(KEY, ops(polar({ benefit_id: TEAM_B }).fetch));
  assert.equal(team.ok && team.record.tier, "Team");
  const dated = await activateLicense(KEY, ops(polar({ expires_at: "2027-01-01T00:00:00Z" }).fetch));
  assert.equal(dated.ok && dated.record.expiresAt, "2027-01-01T00:00:00Z");
});

test("activate failures are reported in plain words: unknown key, activation limit, offline, unreadable reply, bad request, rate limit, empty key", async () => {
  const unknown = await activateLicense(KEY, ops(mockApi({ activate: () => err(404, "License key not found.") }).fetch));
  assert.deepEqual(unknown, { ok: false, error: "Polar said: License key not found." });
  const full = mockApi({ activate: () => err(403, "License key activation limit already reached") });
  const limit = await activateLicense(KEY, ops(full.fetch));
  assert.match(!limit.ok ? limit.error : "", /^Polar refused: License key activation limit already reached\. If every seat of this key is in use, run `cephalo pro deactivate`/);
  assert.deepEqual(full.calls.map((c) => c.action), ["activate"], "nothing was activated, so nothing is given back");
  const bare403 = await activateLicense(KEY, ops(mockApi({ activate: () => err(403) }).fetch));
  assert.match(!bare403.ok ? bare403.error : "", /^Polar refused this key\./);
  const offline = await activateLicense(KEY, ops(async () => { throw new Error("getaddrinfo ENOTFOUND api.polar.sh"); }));
  assert.match(!offline.ok ? offline.error : "", /could not reach the license server \(getaddrinfo ENOTFOUND/);
  const junk = await activateLicense(KEY, ops(async () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } })));
  assert.match(!junk.ok ? junk.error : "", /could not read \(HTTP 200\)/);
  const gateway = await activateLicense(KEY, ops(async () => ({ ok: false, status: 502, json: async () => { throw new Error("not json"); } })));
  assert.match(!gateway.ok ? gateway.error : "", /answered HTTP 502/);
  const bad = await activateLicense(KEY, ops(mockApi({ activate: () => ({ status: 422, body: { detail: [{ loc: ["body", "key"], msg: "x", type: "y" }] } }) }).fetch));
  assert.match(!bad.ok ? bad.error : "", /could not read the request/);
  const slow = await activateLicense(KEY, ops(mockApi({ activate: () => ({ status: 429 }) }).fetch));
  assert.match(!slow.ok ? slow.error : "", /limiting license checks/);
  const noId = await activateLicense(KEY, ops(mockApi({ activate: () => ok({}) }).fetch));
  assert.match(!noId.ok ? noId.error : "", /did not activate this key/);
  assert.deepEqual(await activateLicense("   ", ops(async () => assert.fail("no call for an empty key"))), { ok: false, error: "no license key given." });
});

test("a key that activates but is not ours is refused and its activation is given back: wrong benefit, wrong organization, revoked, or a failed check", async () => {
  const cases: Array<[string, ReturnType<typeof mockApi>, RegExp]> = [
    ["wrong benefit", polar({ benefit_id: "0d0d0d0d-0000-4000-8000-000000000004" }), /not a Cephalo Pro or Team key/],
    ["wrong organization", polar({ organization_id: "0e0e0e0e-0000-4000-8000-000000000005" }), /issued by another Polar seller/],
    ["revoked", polar({ status: "revoked" }), /the license is revoked/],
    ["validate 404", mockApi({ activate: goodActivate(), validate: () => err(404, "License key not found."), deactivate: released }), /did not pass the check that follows: Polar said: License key not found\./],
  ];
  for (const [name, api, why] of cases) {
    const r = await activateLicense(KEY, ops(api.fetch));
    assert.equal(r.ok, false, name);
    assert.match(!r.ok ? r.error : "", why, name);
    assert.deepEqual(api.calls.map((c) => c.action), ["activate", "validate", "deactivate"], `${name}: the seat is given back`);
    assert.deepEqual(api.calls[2]!.body, { key: KEY, organization_id: ORG, activation_id: ACT });
  }
  const stuck = mockApi({ activate: goodActivate({ benefit_id: "other" }), validate: goodValidate({ benefit_id: "other" }), deactivate: () => ({ status: 500 }) });
  const r = await activateLicense(KEY, ops(stuck.fetch));
  assert.match(!r.ok ? r.error : "", /not a Cephalo Pro or Team key\. \(The activation could not be given back: the license server answered HTTP 500\.\)/);
});

test("with the placeholder IDs nothing is activated or renewed, and nothing is sent", async () => {
  const never: Fetch = async () => assert.fail("no request while the Polar IDs are placeholders");
  const a = await activateLicense(KEY, { fetch: never, env: {} });
  assert.equal(a.ok, false);
  assert.match(!a.ok ? a.error : "", /no Polar store set up yet .* Nothing was sent\./);
  const v = await validateLicense(record(), KEY, { fetch: never, env: {} });
  assert.match(!v.ok ? v.error : "", /no Polar store set up yet/);
  assert.equal((await activateLicense(KEY, { fetch: never, env: {}, polar: { ...IDS, teamBenefitId: "REPLACE_ME_POLAR_TEAM_BENEFIT_ID" } })).ok, false, "one placeholder is enough to refuse");
  const w = world({ polar: undefined });
  const cli = await proCommand(["activate", KEY], { ...w.deps, fetch: never });
  assert.equal(cli.exitCode, 1);
  assert.match(cli.lines[0]!, /Could not activate: this copy of Cephalo has no Polar store set up yet/);
  assert.ok(!fs.existsSync(licensePath(w.dir)));
});

test("CEPHALO_POLAR_SANDBOX=1 uses Polar's sandbox and its own IDs; the record remembers it, and the two are never mixed", async () => {
  const env = { CEPHALO_POLAR_SANDBOX: "1", CEPHALO_POLAR_ORG_ID: ORG, CEPHALO_POLAR_PRO_BENEFIT_ID: PRO_B, CEPHALO_POLAR_TEAM_BENEFIT_ID: TEAM_B };
  const api = polar();
  const r = await activateLicense(KEY, { fetch: api.fetch, env, now: NOW, hostname: "laptop" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(api.calls.every((c) => c.url.startsWith("https://sandbox-api.polar.sh/v1/customer-portal/license-keys/")));
  assert.equal(r.ok && r.record.sandbox, true);
  const rec = r.ok ? r.record : record();
  const prod = await validateLicense(rec, KEY, { fetch: async () => assert.fail("not sent to production"), env: {}, polar: IDS });
  assert.match(!prod.ok ? prod.error : "", /activated against Polar's sandbox\. Set CEPHALO_POLAR_SANDBOX=1/);
  assert.equal((await validateLicense(rec, KEY, { fetch: polar().fetch, env, now: NOW })).ok, true);
  const back = await validateLicense(record(), KEY, { fetch: async () => assert.fail("not sent to the sandbox"), env });
  assert.match(!back.ok ? back.error : "", /not the sandbox/);
  const w = world();
  writeLicense(rec, licensePath(w.dir));
  assert.match((await proCommand(["status"], w.deps)).lines[0]!, /\(Polar sandbox\)/);
});

test("validate (renew) refreshes the check date and plan; revoked, disabled or expired keys (Polar's 404) end the license", async () => {
  const api = polar({ benefit_id: TEAM_B, expires_at: "2027-02-01T00:00:00Z" });
  const r = await validateLicense(record({ validatedAt: days(-30), expiresAt: "2026-12-01T00:00:00Z" }), KEY, ops(api.fetch));
  assert.equal(r.ok, true, JSON.stringify(r));
  if (r.ok) {
    assert.equal(r.record.validatedAt, NOW.toISOString());
    assert.equal(r.record.tier, "Team", "an upgrade on the server shows up");
    assert.equal(r.record.expiresAt, "2027-02-01T00:00:00Z");
  }
  assert.deepEqual(api.calls[0]!.body, { key: KEY, organization_id: ORG, activation_id: ACT });
  const cleared = await validateLicense(record({ expiresAt: "2026-12-01T00:00:00Z" }), KEY, ops(polar().fetch));
  assert.equal(cleared.ok && cleared.record.expiresAt, undefined, "a key that no longer expires drops the old date");
  const ended = await validateLicense(record(), KEY, ops(mockApi({ validate: () => err(404, "License key not found.") }).fetch));
  assert.match(!ended.ok ? ended.error : "", /^the license has ended: it was revoked, disabled or expired \(for example, the subscription was cancelled\)/);
  for (const status of ["revoked", "disabled"]) {
    const s = await validateLicense(record(), KEY, ops(polar({ status }).fetch));
    assert.match(!s.ok ? s.error : "", new RegExp(`the license is ${status}`));
  }
  const other = await validateLicense(record(), KEY, ops(polar({ organization_id: "0e0e0e0e-0000-4000-8000-000000000005" }).fetch));
  assert.match(!other.ok ? other.error : "", /another Polar seller/);
  const offline = await validateLicense(record(), KEY, ops(async () => { throw new Error("ECONNRESET"); }));
  assert.match(!offline.ok ? offline.error : "", /could not reach the license server/);
  const legacy = await validateLicense(legacyRecord(), KEY, ops(async () => assert.fail("a Lemon Squeezy record is not sent to Polar")));
  assert.deepEqual(legacy, { ok: false, error: LEGACY_MESSAGE });
});

test("deactivate releases the seat (Polar answers 204) or says why not", async () => {
  const api = mockApi({ deactivate: released });
  assert.deepEqual(await deactivateLicense(record(), KEY, ops(api.fetch)), { ok: true });
  assert.deepEqual(api.calls[0]!.body, { key: KEY, organization_id: ORG, activation_id: ACT });
  const no = await deactivateLicense(record(), KEY, ops(mockApi({ deactivate: () => err(404, "Activation not found") }).fetch));
  assert.deepEqual(no, { ok: false, error: "Polar has no such activation for this key (Activation not found)." });
  const down = await deactivateLicense(record(), KEY, ops(async () => { throw new Error("ETIMEDOUT"); }));
  assert.match(!down.ok ? down.error : "", /could not reach the license server/);
});

/* ------------------------------------------------------------------ cephalo pro */

function world(extra: Partial<Parameters<typeof proCommand>[1]> = {}) {
  const dir = tmp("procmd");
  const npmCalls: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
  let npmStatus = 0;
  let npmStderr = "";
  const target = path.join(dir, "pro", "node_modules", "@nomajorconcerns", "cephalo-pro");
  const deps = {
    dir,
    now: NOW,
    hostname: "laptop",
    env: {} as Record<string, string | undefined>,
    polar: IDS as typeof IDS | undefined,
    // Where the package may be: only the private test folder, never a real install of this machine.
    roots: [target],
    runNpm: (args: string[], env: Record<string, string | undefined>) => {
      npmCalls.push({ args, env });
      if (npmStatus === 0) {
        // behave like npm: put the package where the core looks for it
        fs.mkdirSync(path.join(target, "dist"), { recursive: true });
        fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: "@nomajorconcerns/cephalo-pro", main: "dist/index.js" }));
        fs.writeFileSync(path.join(target, "dist", "index.js"), "module.exports = {};");
      }
      return { status: npmStatus, stderr: npmStderr };
    },
    ...extra,
  };
  return { dir, deps, npmCalls, target, failNpm: (stderr: string, status = 1) => ((npmStatus = status), (npmStderr = stderr)) };
}
const proDirOf = (dir: string) => path.join(dir, "pro");
const tgz = (dir: string, name = "cephalo-pro-0.2.0.tgz") => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, "not really a tarball");
  return f;
};

test("activate: asks the server, stores a record without the key, and says how to get the package when it is not installed", async () => {
  const w = world();
  const api = polar();
  const r = await proCommand(["activate", KEY], { ...w.deps, fetch: api.fetch });
  assert.equal(r.exitCode, 0, r.lines.join("\n"));
  const text = r.lines.join("\n");
  assert.match(text, /Activated: Cephalo Pro on laptop \(key ending 4D51\)/);
  assert.match(text, /The Pro package is not installed yet/);
  assert.match(text, /npm install -g \.\/cephalo-pro-0\.2\.0\.tgz/);
  const saved = fs.readFileSync(licensePath(w.dir), "utf8");
  assert.ok(!saved.includes(KEY));
  assert.equal(JSON.parse(saved).tier, "Pro");
  assert.equal(w.npmCalls.length, 0, "activating never runs npm");
  assert.ok(!text.includes(KEY));
});

test("activate when the package is already installed (in either order of the two steps) says it is ready", async () => {
  const w = world();
  w.deps.runNpm([], {}); // puts the package in place
  const r = await proCommand(["activate", KEY], { ...w.deps, fetch: polar().fetch });
  assert.equal(r.exitCode, 0);
  assert.match(r.lines.join("\n"), /The Pro package is installed\. Try: cephalo bench/);
});

test("a Team key is recognised by its benefit, and a Pro key by its own; the organization must be ours", async () => {
  const team = await proCommand(["activate", KEY], { ...world().deps, fetch: polar({ benefit_id: TEAM_B }).fetch });
  assert.match(team.lines[0]!, /Cephalo Team/);
  const pro = await proCommand(["activate", KEY], { ...world().deps, fetch: polar({ benefit_id: PRO_B }).fetch });
  assert.match(pro.lines[0]!, /Cephalo Pro/);
  const elsewhere = polar({ organization_id: "0e0e0e0e-0000-4000-8000-000000000005" });
  const w = world();
  const r = await proCommand(["activate", KEY], { ...w.deps, fetch: elsewhere.fetch });
  assert.equal(r.exitCode, 1);
  assert.match(r.lines[0]!, /another Polar seller/);
  assert.ok(!fs.existsSync(licensePath(w.dir)));
  assert.deepEqual(elsewhere.calls.map((c) => c.action), ["activate", "validate", "deactivate"], "the seat is given back");
  const saved = await proCommand(["activate", KEY], { ...w.deps, fetch: polar().fetch });
  assert.equal(JSON.parse(fs.readFileSync(licensePath(w.dir), "utf8")).provider, "polar", saved.lines.join("\n"));
});

test("`pro install <file>`: installs the downloaded package into ~/.cephalo/pro without scripts and with no token or registry setting", () => {
  const w = world();
  const f = tgz(w.dir);
  const r = installProFile(f, w.deps);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.match(r.lines[0]!, /Installed @nomajorconcerns\/cephalo-pro into/);
  assert.equal(w.npmCalls.length, 1);
  const a = w.npmCalls[0]!.args;
  assert.deepEqual(a.slice(0, 2), ["install", path.resolve(f)]);
  assert.ok(a.includes("--ignore-scripts"));
  assert.equal(a[a.indexOf("--prefix") + 1], proDirOf(w.dir));
  assert.ok(!a.some((x) => /registry|userconfig|authToken|pkg\.github/i.test(x)), "no registry or credential settings are involved");
  assert.ok(proEntry(w.dir, w.deps.roots));
});

test("`pro install` refuses a file that is not a package, a missing file and no argument; a failed npm run is explained", async () => {
  const w = world();
  assert.match(installProFile(path.join(w.dir, "notes.txt"), w.deps).lines[0]!, /is not a package file/);
  assert.match(installProFile(path.join(w.dir, "missing.tgz"), w.deps).lines[0]!, /No file at/);
  assert.equal(w.npmCalls.length, 0);
  const none = await proCommand(["install"], w.deps);
  assert.equal(none.exitCode, 1);
  assert.match(none.lines.join("\n"), /cephalo pro install \.\/cephalo-pro-0\.2\.0\.tgz/);
  assert.match(none.lines.join("\n"), /npm install -g/);
  w.failNpm("npm ERR! network request failed");
  const bad = await proCommand(["install", tgz(w.dir)], w.deps);
  assert.equal(bad.exitCode, 1);
  assert.match(bad.lines.join("\n"), /Could not install/);
  assert.match(bad.lines.join("\n"), /npm needs to fetch one dependency/);
  const ok = world();
  assert.equal((await proCommand(["install", tgz(ok.dir)], ok.deps)).exitCode, 0);
});


test("activate: nothing is written when the server says no; a machine with a current license is not activated twice; no key means a plain message", async () => {
  const w = world();
  const r = await proCommand(["activate", KEY], { ...w.deps, fetch: mockApi({ activate: () => err(403, "License key activation limit already reached") }).fetch });
  assert.equal(r.exitCode, 1);
  assert.match(r.lines[0]!, /Could not activate: Polar refused: License key activation limit already reached\. If every seat of this key is in use, run `cephalo pro deactivate` on a machine you no longer use/);
  assert.ok(!fs.existsSync(licensePath(w.dir)));
  assert.equal(w.npmCalls.length, 0);
  assert.equal((await proCommand(["activate"], w.deps)).exitCode, 1, "no terminal and no key");
  assert.match((await proCommand(["activate"], w.deps)).lines[0]!, /No license key/);
  const fromEnv = world({ env: { CEPHALO_LICENSE_KEY: KEY } });
  assert.equal((await proCommand(["activate"], { ...fromEnv.deps, fetch: polar().fetch })).exitCode, 0, "the key can come from the environment");
  const asked = world({ readKey: async () => KEY });
  assert.equal((await proCommand(["activate"], { ...asked.deps, fetch: polar().fetch })).exitCode, 0, "the hidden prompt supplies it");
  writeLicense(record({ validatedAt: NOW.toISOString() }), licensePath(w.dir));
  assert.match((await proCommand(["activate", KEY], w.deps)).lines[0]!, /already has a Pro license/);
});

test("status: Free with a pointer to the plans; a current license; stale; expired; and what is missing", async () => {
  const w = world();
  let r = await proCommand([], w.deps);
  assert.match(r.lines.join("\n"), /Plan: Free \(everything that was in 0\.1\.1/);
  assert.match(r.lines.join("\n"), /network egress allowlist, the tamper-evident audit log and the bypass benchmark/);
  assert.match(r.lines.join("\n"), /cephalo pro activate/);
  writeLicense(record({ validatedAt: days(-5), email: "a@example.com" }), licensePath(w.dir));
  r = await proCommand(["status"], w.deps);
  assert.match(r.lines[0]!, /Plan: Pro \(a@example\.com\), key ending 4D51, on laptop/);
  assert.match(r.lines[1]!, /trusted for 30 more day\(s\)/);
  assert.match(r.lines[2]!, /Package: .*not installed/);
  writeLicense(record({ validatedAt: days(-40) }), licensePath(w.dir));
  assert.match((await proCommand(["status"], w.deps)).lines[1]!, /last checked 40 days ago, so the paid features are off\. Run: cephalo pro renew/);
  writeLicense(record({ expiresAt: days(-2) }), licensePath(w.dir));
  assert.match((await proCommand(["status"], w.deps)).lines[1]!, /expired/);
  assert.match((await proCommand(["path"], w.deps)).lines.join("\n"), /license\.json/);
  assert.equal((await proCommand(["wat"], w.deps)).exitCode, 1);
  assert.match(PRO_USAGE, /about every 35 days/);
});

test("renew refreshes a stale license; a cancelled one is not renewed and stays stale", async () => {
  const w = world();
  writeLicense(record({ validatedAt: days(-40) }), licensePath(w.dir));
  const bad = await proCommand(["renew", KEY], { ...w.deps, fetch: mockApi({ validate: () => err(404, "License key not found.") }).fetch });
  assert.equal(bad.exitCode, 1);
  assert.match(bad.lines[0]!, /not renewed: the license has ended: it was revoked, disabled or expired/);
  assert.equal(licenseState(readLicense(licensePath(w.dir)), NOW).state, "stale");
  const ok = await proCommand(["renew", KEY], { ...w.deps, fetch: polar().fetch });
  assert.equal(ok.exitCode, 0);
  assert.equal(licenseState(readLicense(licensePath(w.dir)), NOW).state, "active");
  assert.equal((await proCommand(["renew", KEY], world().deps)).exitCode, 1, "nothing to renew");
});

test("deactivate gives the seat back and removes the record; if the server refuses, nothing changes here", async () => {
  const w = world();
  writeLicense(record(), licensePath(w.dir));
  const no = await proCommand(["deactivate", KEY], { ...w.deps, fetch: mockApi({ deactivate: () => ({ status: 500 }) }).fetch });
  assert.equal(no.exitCode, 1);
  assert.ok(readLicense(licensePath(w.dir)), "still licensed here");
  const yes = await proCommand(["deactivate", KEY], { ...w.deps, fetch: mockApi({ deactivate: released }).fetch });
  assert.equal(yes.exitCode, 0);
  assert.ok(!fs.existsSync(licensePath(w.dir)));
  assert.match(yes.lines.join("\n"), /left alone/);
  assert.equal((await proCommand(["deactivate", KEY], w.deps)).exitCode, 0, "already none");
});

test("`cephalo pro` with a Lemon Squeezy record from 0.2.0: status says re-activate with Polar, renew sends nothing, deactivate removes it, activate replaces it", async () => {
  const never: Fetch = async () => assert.fail("nothing about a Lemon Squeezy record is sent anywhere");
  const w = world({ fetch: never, readKey: async () => assert.fail("no key is asked for") });
  fs.writeFileSync(licensePath(w.dir), JSON.stringify(legacyRecord()));
  const st = await proCommand(["status"], w.deps);
  assert.equal(st.exitCode, 0);
  assert.match(st.lines[0]!, /Plan: Free for now\. This license was activated with Lemon Squeezy, which Cephalo no longer uses\. Re-activate with a Polar key/);
  const renew = await proCommand(["renew"], w.deps);
  assert.deepEqual([renew.exitCode, renew.lines], [1, [LEGACY_MESSAGE]]);
  const act = await proCommand(["activate", KEY], { ...w.deps, fetch: polar().fetch });
  assert.equal(act.exitCode, 0, "an old record does not block activating with Polar");
  assert.equal(readLicense(licensePath(w.dir))!.provider, "polar");
  fs.writeFileSync(licensePath(w.dir), JSON.stringify(legacyRecord()));
  const off = await proCommand(["deactivate"], w.deps);
  assert.equal(off.exitCode, 0);
  assert.match(off.lines[0]!, /Removed this machine's old Lemon Squeezy license record/);
  assert.ok(!fs.existsSync(licensePath(w.dir)));
});

/* ------------------------------------------------------------------ loading the package */

function installedDir(mod: string, license: Partial<LicenseRecord> = {}) {
  const dir = tmp("load");
  writeLicense(record({ validatedAt: NOW.toISOString(), ...license }), licensePath(dir));
  const pkg = path.join(dir, "pro", "node_modules", "@nomajorconcerns", "cephalo-pro");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@nomajorconcerns/cephalo-pro", main: "index.js" }));
  fs.writeFileSync(path.join(pkg, "index.js"), mod);
  return dir;
}

test("loadPro: loads a compatible package for a current license; every other state says why not", () => {
  const good = installedDir(`module.exports = { apiVersion: ${PLUGIN_API_VERSION}, commands: { bench() { return 0; } } };`);
  const ok = loadPro({ dir: good, now: NOW });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.runtime.tier, "Pro");
  assert.equal(typeof (ok.ok && ok.runtime.commands.bench), "function");
  assert.deepEqual(loadPro({ dir: tmp("none"), now: NOW }), { ok: false, reason: "no-license" });
  const stale = loadPro({ dir: installedDir("module.exports={}", { validatedAt: days(-60) }), now: NOW });
  assert.equal(stale.ok, false);
  assert.equal(!stale.ok && stale.reason, "stale");
  assert.equal(!loadPro({ dir: installedDir("module.exports={}", { expiresAt: days(-1) }), now: NOW }).ok && true, true);
  const missing = tmp("missing");
  writeLicense(record({ validatedAt: NOW.toISOString() }), licensePath(missing));
  assert.deepEqual(loadPro({ dir: missing, now: NOW }), { ok: false, reason: "not-installed" });
  const wrong = loadPro({ dir: installedDir("module.exports = { apiVersion: 99, commands: {} };"), now: NOW });
  assert.equal(!wrong.ok && wrong.reason, "incompatible");
  assert.match(!wrong.ok ? wrong.detail! : "", /plugin API 99, this Cephalo speaks 1/);
  const broken = loadPro({ dir: installedDir("throw new Error('kaput');"), now: NOW });
  assert.equal(!broken.ok && broken.reason, "broken");
  assert.match(!broken.ok ? broken.detail! : "", /kaput/);
  assert.equal(!loadPro({ dir: installedDir("module.exports = 5;"), now: NOW }).ok, true);
  assert.equal(!loadPro({ dir: installedDir("module.exports = { apiVersion: 1 };"), now: NOW }).ok, true, "no commands table");
});

test("loadPro never looks in the current directory: a repository cannot plant its own copy", () => {
  const dir = tmp("plant");
  writeLicense(record({ validatedAt: NOW.toISOString() }), licensePath(dir));
  const repo = tmp("repo");
  const planted = path.join(repo, "node_modules", "@nomajorconcerns", "cephalo-pro");
  fs.mkdirSync(planted, { recursive: true });
  fs.writeFileSync(path.join(planted, "package.json"), JSON.stringify({ name: "@nomajorconcerns/cephalo-pro", main: "index.js" }));
  fs.writeFileSync(path.join(planted, "index.js"), "throw new Error('planted code ran')");
  const before = process.cwd();
  process.chdir(repo);
  try {
    assert.deepEqual(loadPro({ dir, now: NOW }), { ok: false, reason: "not-installed" });
  } finally {
    process.chdir(before);
  }
});

test("what a person sees when a paid command is run without the package, in each state", () => {
  const msg = (reason: string, detail?: string) => notAvailableMessage("bench", { ok: false, reason, detail } as never).join("\n");
  assert.match(msg("no-license"), /"cephalo bench" is part of Cephalo Pro \(also in Team\)\./);
  assert.match(msg("no-license"), /https:\/\/nomajorconcerns\.github\.io\/cephalo\/#pricing/);
  assert.match(msg("no-license"), /Already bought it\? Run: cephalo pro activate/);
  assert.match(msg("no-license"), /Everything that was in Cephalo 0\.1\.1 is free and keeps working\./);
  assert.match(msg("stale", "last checked 40 days ago"), /last checked 40 days ago\. Run: cephalo pro renew/);
  assert.match(msg("expired"), /expired/);
  assert.match(msg("not-installed"), /npm install -g \.\/cephalo-pro-0\.2\.0\.tgz/);
  assert.match(msg("not-installed"), /Polar purchase/);
  assert.match(msg("incompatible", "x"), /does not match this Cephalo/);
  assert.match(msg("incompatible", "x"), /Download the current cephalo-pro/);
  assert.match(msg("broken", "boom"), /could not be loaded \(boom\)/);
  assert.deepEqual(Object.keys(PAID_COMMANDS).sort(), ["audit", "bench", "egress"], "only the three new features are paid");
});

/* ------------------------------------------------------------------ the hook, with a stand-in for the package */

const pre = (command: string, tool = "Bash") => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command }, session_id: "s" });
function fakePro(decision: "allow" | "block" | "ask" = "block"): { rt: ProRuntime; seen: EgressInput[]; lines: Array<{ file: string; line: string }> } {
  const seen: EgressInput[] = [];
  const lines: Array<{ file: string; line: string }> = [];
  const rt: ProRuntime = {
    apiVersion: 1,
    tier: "Pro",
    commands: {},
    egress: { check: (input) => (seen.push(input), /evil/.test(JSON.stringify(input)) ? { decision, reason: "Network egress to evil.example is not on your allowlist", hosts: ["evil.example"] } : null) },
    audit: { append: (file, line) => { lines.push({ file, line }); fs.appendFileSync(file, line + "\n"); } },
  };
  return { rt, seen, lines };
}

test("hook: the paid egress check can block a call, and the reason reaches the agent and the log", () => {
  const dir = tmp("hookpro");
  const auditFile = path.join(dir, "audit.jsonl");
  const f = fakePro("block");
  const out = JSON.parse(runHook("claude", pre("curl https://evil.example/x"), { rules: [], auditFile, pro: f.rt }));
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /egress-allowlist/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /evil\.example is not on your allowlist/);
  assert.equal(runHook("claude", pre("ls"), { rules: [], auditFile, pro: f.rt }), "");
  const e = readAudit({ limit: 0 }, auditFile);
  assert.deepEqual(e.map((x) => [x.decision, x.rule]), [["block", "egress-allowlist"], ["allow", undefined]]);
  assert.match(e[0]!.note ?? "", /egress: evil\.example/);
  assert.equal(f.lines.length, 2, "every line went through the package's writer");
});

test("hook: the egress check gets the raw command plus what the parser found inside it; web tools get URLs; MCP calls get their parameters", () => {
  const dir = tmp("hookin");
  const f = fakePro("block");
  const opts = { rules: [], auditFile: path.join(dir, "a.jsonl"), pro: f.rt };
  runHook("claude", pre(`bash -c "curl https://x.example/a | tee out"`), opts);
  const first = f.seen[0]!;
  assert.equal(first.commands![0], `bash -c "curl https://x.example/a | tee out"`);
  assert.ok(first.commands!.some((c) => c.includes("curl https://x.example/a")), "the inner command is listed on its own");
  assert.equal(first.unreadable, false);
  runHook("claude", pre(`echo "unterminated`), opts);
  assert.equal(f.seen[1]!.unreadable, true);
  runHook("claude", JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "WebFetch", tool_input: { url: "https://y.example/p" }, session_id: "s" }), opts);
  assert.deepEqual(f.seen[2], { urls: ["https://y.example/p"] });
  runHook("hermes", JSON.stringify({ hook_event_name: "pre_tool_call", tool_name: "web_extract", tool_input: { urls: ["https://a.example", "https://b.example"] }, session_id: "s" }), opts);
  assert.deepEqual(f.seen[3], { urls: ["https://a.example", "https://b.example"] });
  runHook("claude", JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "mcp__srv__tool", tool_input: { endpoint: "https://z.example" }, session_id: "s" }), { ...opts, mcp: { policy: { mode: "audit" as const, allow: [] }, servers: [] } });
  assert.deepEqual(f.seen[4], { params: { endpoint: "https://z.example" } });
  runHook("claude", JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "WebSearch", tool_input: { query: "weather" }, session_id: "s" }), opts);
  assert.deepEqual(f.seen[5], { urls: [] }, "a search sends no URL of the agent's choosing");
});

test("hook: ask goes to the user in Claude Code and is a block where the agent cannot ask; a call a rule already blocked is not re-checked", () => {
  const dir = tmp("hookask");
  const f = fakePro("ask");
  const opts = { rules: [], auditFile: path.join(dir, "a.jsonl"), pro: f.rt };
  assert.equal(JSON.parse(runHook("claude", pre("curl https://evil.example"), opts)).hookSpecificOutput.permissionDecision, "ask");
  assert.match(runHook("hermes", JSON.stringify({ hook_event_name: "pre_tool_call", tool_name: "terminal", tool_input: { command: "curl https://evil.example" }, session_id: "s" }), opts), /"action":"block"/);
  const n = f.seen.length;
  const rules = [{ id: "no-x", description: "d", type: "command" as const, pattern: "evil", action: "block" as const }];
  runHook("claude", pre("curl https://evil.example"), { ...opts, rules });
  assert.equal(f.seen.length, n, "already blocked: the paid check is skipped");
});

test("hook: with no package nothing changes, and a package that throws follows the usual fail-open / fail-closed rule", () => {
  const dir = tmp("hookoff");
  assert.equal(runHook("claude", pre("curl https://evil.example"), { rules: [], auditFile: path.join(dir, "a.jsonl") }), "");
  const boom: ProRuntime = { apiVersion: 1, tier: "Pro", commands: {}, egress: { check: () => { throw new Error("egress exploded"); } } };
  assert.equal(runHook("claude", pre("ls"), { rules: [], auditFile: path.join(dir, "b.jsonl"), pro: boom }), "", "fail open by default");
  const closed = runHook("claude", pre("ls"), { rules: [], auditFile: path.join(dir, "c.jsonl"), pro: boom, config: { failClosed: true, shadow: false, askDefault: "block", hookTimeoutSeconds: 8 } });
  assert.match(closed, /fail-closed|could not check/);
});

test("the audit writer is used for everything the CLI writes, and a failing writer never loses the entry", () => {
  const dir = tmp("sink");
  const file = path.join(dir, "audit.jsonl");
  const got: string[] = [];
  appendAudit({ ts: "t", agent: "a", tool: "Bash", decision: "allow", command: "echo ok" }, file, (_f, line) => { got.push(line); fs.appendFileSync(file, line + "\n"); });
  assert.equal(got.length, 1);
  assert.equal(JSON.parse(got[0]!).command, "echo ok");
  // a token in a command is redacted BEFORE the writer sees it (so it can never be in a hashed line)
  appendAudit({ ts: "t", agent: "a", tool: "Bash", decision: "block", command: "curl -H 'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789'" }, file, (_f, line) => void got.push(line));
  assert.ok(!got[1]!.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
  const realErr = process.stderr.write;
  let err = "";
  process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
  try {
    appendAudit({ ts: "t", agent: "a", tool: "Bash", decision: "allow", command: "kept" }, file, () => { throw new Error("no space left"); });
  } finally {
    process.stderr.write = realErr;
  }
  assert.match(err, /chained audit write failed \(no space left\); wrote the line without a chain/);
  assert.match(fs.readFileSync(file, "utf8"), /"command":"kept"/);
});

/* ------------------------------------------------------------------ keeping agents out of the paid files */

test("agents cannot write the license, the egress allowlist, the Pro package or the audit head file, nor change them through Cephalo's own commands", () => {
  const host = getPlatform();
  const home = os.homedir();
  for (const f of ["license.json", "egress.yml", path.join("pro", "node_modules", "x", "index.js"), "audit.jsonl.head"]) {
    const r = evaluate({ path: path.join(home, ".cephalo", f), access: "write" }, [...SYSTEM_RULES], host);
    assert.equal(r.decision, "block", f);
  }
  assert.equal(evaluate({ path: path.join(home, ".cephalo", "egress.yml"), access: "read" }, [...SYSTEM_RULES], host).decision, "allow", "reading the allowlist is fine");
  const linux = getPlatform("linux");
  const BLOCK = [
    "echo 'allow: [evil.example]' > ~/.cephalo/egress.yml",
    "cp /tmp/x ~/.cephalo/license.json",
    "rm -r ~/.cephalo/pro",
    "tee /home/u/.cephalo/audit.jsonl.head < /dev/null",
    `python3 -c "open('/home/u/.cephalo/egress.yml','w').write('allow: [evil.example]')"`,
    "cephalo egress allow evil.example",
    "cephalo egress remove github.com",
    "cephalo egress mode ask",
    "cephalo pro deactivate",
    "cephalo pro activate KEY",
    "cephalo config set fail-closed off",
    "cephalo rules reset --yes",
    "node /opt/cephalo/dist/cli.js egress allow evil.example",
  ];
  for (const c of BLOCK) assert.equal(evaluate({ command: c }, [...SYSTEM_RULES], linux).decision, "block", c);
  for (const c of ["cephalo egress list", "cephalo egress test \"curl https://example.com\"", "cephalo pro status", "cephalo bench", "cephalo audit verify", "cat ~/.cephalo/egress.yml", "cephalo config list"]) {
    assert.equal(evaluate({ command: c }, [...SYSTEM_RULES], linux).decision, "allow", c);
  }
});

test("on Windows too: the POSIX shell commands agents use under Git Bash or WSL are covered", () => {
  const win = getPlatform("win32");
  const rules = win.rules();
  for (const c of ["rm -r -f ./build", "rm --recursive --force ./build", "rm --no-preserve-root -r /", "find ./build -delete", 'find . -name "*.log" -exec rm {} \\;']) {
    assert.equal(evaluate({ command: c }, rules, win).decision, "block", c);
  }
  assert.equal(evaluate({ command: "rm build/output.txt" }, rules, win).decision, "allow");
  assert.equal(evaluate({ command: "find . -name '*.ts'" }, rules, win).decision, "allow");
});

/* ------------------------------------------------------------------ the real CLI */

function cli(args: string[], env: Record<string, string> = {}, input = "") {
  const home = tmp("proclihome");
  const r = spawnSync(process.execPath, [CLI, ...args], { input, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "", HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, "lad"), CEPHALO_LICENSE_KEY: "", CEPHALO_PACKAGES_TOKEN: "", ...env } });
  return { ...r, home };
}

test("real CLI, no license: the three paid commands say what they are and where to buy, exit 1, print nothing on stdout", () => {
  for (const c of ["bench", "egress", "audit"]) {
    const r = cli([c, "verify"]);
    assert.equal(r.status, 1, c);
    assert.equal(r.stdout, "", c);
    assert.match(r.stderr, new RegExp(`"cephalo ${c}" is part of Cephalo Pro`));
    assert.match(r.stderr, /#pricing/);
    assert.match(r.stderr, /Everything that was in Cephalo 0\.1\.1 is free/);
  }
  const s = cli(["pro", "status"]);
  assert.equal(s.status, 0);
  assert.match(s.stdout, /Plan: Free/);
  assert.match(cli(["pro", "--help"]).stdout, /Usage: cephalo pro/);
  assert.match(cli(["--help"]).stdout, /cephalo pro \[status\|activate\|renew\]/);
});

test("real CLI: a license record with no package installed points at the downloaded package; hooks and free commands are unaffected", () => {
  const home = tmp("proclihome2");
  fs.mkdirSync(path.join(home, ".cephalo"), { recursive: true });
  writeLicense(record({ validatedAt: new Date().toISOString() }), path.join(home, ".cephalo", "license.json"));
  const env = { ...process.env, NO_COLOR: "1", HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, "lad") };
  const r = spawnSync(process.execPath, [CLI, "bench"], { encoding: "utf8", env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /license is active but the Pro package is not installed/);
  assert.match(r.stderr, /npm install -g \.\/cephalo-pro-0\.2\.0\.tgz/);
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push --force origin main" }, session_id: "s" });
  const h = spawnSync(process.execPath, [CLI, "hook", "claude"], { input: payload, encoding: "utf8", env });
  assert.equal(h.status, 0);
  assert.match(JSON.parse(h.stdout).hookSpecificOutput.permissionDecisionReason, /no-force-push/);
  assert.doesNotMatch(h.stderr, /Pro package|cephalo pro/, "the hook says nothing about the missing package");
  assert.equal(spawnSync(process.execPath, [CLI, "test", "ls"], { encoding: "utf8", env }).status, 0);
});

test("a global install of the downloaded .tgz is found next to Cephalo, and nowhere else outside ~/.cephalo/pro", () => {
  const dir = tmp("roots");
  const roots = proRoots(dir);
  assert.equal(roots[roots.length - 1], path.join(dir, "pro", "node_modules", "@nomajorconcerns", "cephalo-pro"));
  // run from this repository (not under node_modules/@nomajorconcerns/cephalo) there is no sibling folder
  assert.equal(roots.length, 1);
  const nm = tmp("global");
  const pkg = path.join(nm, "node_modules", "@nomajorconcerns", "cephalo-pro");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@nomajorconcerns/cephalo-pro", main: "index.js" }));
  fs.writeFileSync(path.join(pkg, "index.js"), "module.exports = {};");
  assert.equal(proEntry(dir, [pkg]), path.join(pkg, "index.js"));
  // a folder with that name but another package inside is not taken for ours
  const imposter = tmp("imposter");
  fs.writeFileSync(path.join(imposter, "package.json"), JSON.stringify({ name: "left-pad", main: "index.js" }));
  fs.writeFileSync(path.join(imposter, "index.js"), "throw new Error('ran')");
  assert.equal(proEntry(dir, [imposter]), null);
  // the first place that has it wins, and a missing one is skipped
  assert.equal(proEntry(dir, [path.join(nm, "nope"), pkg]), path.join(pkg, "index.js"));
});

test("when Cephalo is installed in a node_modules folder, the Pro package next to it is protected like dist/", () => {
  const base = tmp("globalroot");
  const cephalo = path.join(base, "node_modules", "@nomajorconcerns", "cephalo");
  const rules = installGuardRules([cephalo]);
  const pro = path.join(base, "node_modules", "@nomajorconcerns", "cephalo-pro");
  const w = (p: string) => evaluate({ path: p, access: "write" }, rules, getPlatform("linux"));
  assert.equal(w(path.join(pro, "dist", "index.js")).rule?.id, "protect-cephalo-pro-install");
  assert.equal(w(path.join(pro, "package.json")).rule?.id, "protect-cephalo-pro-install");
  assert.equal(w(path.join(base, "node_modules", "@nomajorconcerns", "cephalo-pro-other", "x")).decision, "allow");
  const slash = pro.split(path.sep).join("/");
  const sh = (c: string) => evaluate({ command: c }, rules, getPlatform("linux"));
  assert.equal(sh(`echo x > ${slash}/dist/index.js`).rule?.id, "no-pro-install-tamper");
  assert.equal(sh(`rm -f ${slash}/dist/index.js`).rule?.id, "no-pro-install-tamper");
  assert.equal(sh(`cat ${slash}/dist/index.js`).decision, "allow", "reading is fine");
  // a clone or npm link (not in a scoped node_modules) has no sibling to protect
  assert.ok(!installGuardRules([tmp("clone")]).some((r) => r.id.includes("pro-install")));
});
