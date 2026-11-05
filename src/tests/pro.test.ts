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
  LICENSE_VALID_DAYS,
  LS_PRO_PRODUCT_ID,
  LS_STORE_ID,
  LS_TEAM_PRODUCT_ID,
  PAID_COMMANDS,
  PLUGIN_API_VERSION,
  activateLicense,
  deactivateLicense,
  licensePath,
  licenseState,
  loadPro,
  notAvailableMessage,
  proEntry,
  proRoots,
  readLicense,
  tierFromMeta,
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
const record = (o: Partial<LicenseRecord> = {}): LicenseRecord => ({ version: 1, tier: "Pro", instanceId: "inst-1", instanceName: "laptop", keyHint: "4d51", activatedAt: days(0), validatedAt: days(0), ...o });
const KEY = "38b1460a-5104-4067-a91d-77b872934d51";

/** A mock of the Lemon Squeezy license API. Records every call; never touches the network. */
function mockApi(handlers: Partial<Record<"activate" | "validate" | "deactivate", (form: URLSearchParams) => unknown>>) {
  const calls: Array<{ action: string; form: URLSearchParams; url: string }> = [];
  const fetch: Fetch = async (url, init) => {
    const action = url.split("/").pop()!;
    const form = new URLSearchParams(init.body);
    calls.push({ action, form, url });
    assert.equal(init.method, "POST");
    assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded");
    const h = handlers[action as "activate"];
    if (!h) throw new Error(`unexpected call to ${action}`);
    const body = h(form);
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetch, calls };
}
const goodActivate = (product: number = LS_PRO_PRODUCT_ID) => () => ({ activated: true, error: null, license_key: { status: "active", key: KEY, expires_at: null }, instance: { id: "inst-1", name: "laptop" }, meta: { store_id: LS_STORE_ID, product_id: product, customer_email: "a@example.com" } });

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

test("tier comes from the store and product the key was sold under; anything else is not a Cephalo key", () => {
  assert.equal(LS_STORE_ID, 513818);
  assert.equal(LS_PRO_PRODUCT_ID, 1504334);
  assert.equal(LS_TEAM_PRODUCT_ID, 1504325);
  assert.equal(tierFromMeta({ store_id: 513818, product_id: 1504334 }), "Pro");
  assert.equal(tierFromMeta({ store_id: 513818, product_id: 1504325 }), "Team");
  assert.equal(tierFromMeta({ store_id: 513818, product_id: 1 }), null, "our store, some other product");
  assert.equal(tierFromMeta({ store_id: 1, product_id: 1504334 }), null, "another store that happens to share a product id");
  assert.equal(tierFromMeta({ store_id: 513818, variant_name: "Cephalo Pro" }), null, "a name is not an id");
  assert.equal(tierFromMeta({ variant_name: "Cephalo Pro" }), null);
  assert.equal(tierFromMeta(undefined), null);
});

/* ------------------------------------------------------------------ the license API client */

test("activate sends the key and a machine name, and returns a record without the key", async () => {
  const api = mockApi({ activate: goodActivate() });
  const r = await activateLicense(`  ${KEY}  `, { fetch: api.fetch, now: NOW, hostname: "laptop" });
  assert.equal(r.ok, true);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0]!.url, "https://api.lemonsqueezy.com/v1/licenses/activate");
  assert.equal(api.calls[0]!.form.get("license_key"), KEY);
  assert.equal(api.calls[0]!.form.get("instance_name"), "laptop");
  if (r.ok) {
    assert.deepEqual(r.record, record({ activatedAt: NOW.toISOString(), validatedAt: NOW.toISOString(), email: "a@example.com" }));
    assert.ok(!JSON.stringify(r.record).includes(KEY));
  }
  const team = await activateLicense(KEY, { fetch: mockApi({ activate: goodActivate(LS_TEAM_PRODUCT_ID) }).fetch });
  assert.equal(team.ok && team.record.tier, "Team");
  const dated = await activateLicense(KEY, { fetch: mockApi({ activate: () => ({ ...(goodActivate()() as object), license_key: { status: "active", expires_at: "2027-01-01T00:00:00Z" } }) }).fetch });
  assert.equal(dated.ok && dated.record.expiresAt, "2027-01-01T00:00:00Z");
});

test("activate failures are reported in plain words: bad key, seats used up, offline, unreadable reply, empty key", async () => {
  const refused = await activateLicense(KEY, { fetch: mockApi({ activate: () => ({ activated: false, error: "license_key not found." }) }).fetch });
  assert.deepEqual(refused, { ok: false, error: "the license server said: license_key not found." });
  const noMessage = await activateLicense(KEY, { fetch: mockApi({ activate: () => ({ activated: false }) }).fetch });
  assert.match(!noMessage.ok ? noMessage.error : "", /did not activate this key/);
  const offline = await activateLicense(KEY, { fetch: async () => { throw new Error("getaddrinfo ENOTFOUND api.lemonsqueezy.com"); } });
  assert.match(!offline.ok ? offline.error : "", /could not reach the license server \(getaddrinfo ENOTFOUND/);
  const junk = await activateLicense(KEY, { fetch: async () => ({ ok: false, status: 502, json: async () => { throw new Error("not json"); } }) });
  assert.match(!junk.ok ? junk.error : "", /could not read \(HTTP 502\)/);
  assert.deepEqual(await activateLicense("   ", { fetch: async () => assert.fail("no call for an empty key") }), { ok: false, error: "no license key given." });
});

test("a valid key for some other product is refused and its seat is given back", async () => {
  const api = mockApi({ activate: goodActivate(999), deactivate: () => ({ deactivated: true }) });
  const r = await activateLicense(KEY, { fetch: api.fetch });
  assert.deepEqual(r, { ok: false, error: "that key is valid, but it is not a Cephalo Pro or Team key." });
  assert.deepEqual(api.calls.map((c) => c.action), ["activate", "deactivate"]);
  assert.equal(api.calls[1]!.form.get("instance_id"), "inst-1");
});

test("validate refreshes the check date; an invalid, disabled or expired key does not", async () => {
  const api = mockApi({ validate: () => ({ valid: true, license_key: { status: "active", expires_at: "2027-02-01T00:00:00Z" }, meta: { store_id: LS_STORE_ID, product_id: LS_TEAM_PRODUCT_ID } }) });
  const r = await validateLicense(record({ validatedAt: days(-30) }), KEY, { fetch: api.fetch, now: NOW });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.record.validatedAt, NOW.toISOString());
    assert.equal(r.record.tier, "Team", "an upgrade on the server shows up");
    assert.equal(r.record.expiresAt, "2027-02-01T00:00:00Z");
  }
  assert.equal(api.calls[0]!.form.get("instance_id"), "inst-1");
  const dead = await validateLicense(record(), KEY, { fetch: mockApi({ validate: () => ({ valid: false, error: "license_key is disabled." }) }).fetch });
  assert.deepEqual(dead, { ok: false, error: "the license server said: license_key is disabled." });
  const status = await validateLicense(record(), KEY, { fetch: mockApi({ validate: () => ({ valid: false, license_key: { status: "expired" } }) }).fetch });
  assert.match(!status.ok ? status.error : "", /the license is expired/);
});

test("deactivate releases the seat or says why not", async () => {
  assert.deepEqual(await deactivateLicense(record(), KEY, { fetch: mockApi({ deactivate: () => ({ deactivated: true }) }).fetch }), { ok: true });
  const no = await deactivateLicense(record(), KEY, { fetch: mockApi({ deactivate: () => ({ deactivated: false, error: "instance not found" }) }).fetch });
  assert.deepEqual(no, { ok: false, error: "the license server said: instance not found" });
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
  const api = mockApi({ activate: goodActivate() });
  const r = await proCommand(["activate", KEY], { ...w.deps, fetch: api.fetch });
  assert.equal(r.exitCode, 0, r.lines.join("\n"));
  const text = r.lines.join("\n");
  assert.match(text, /Activated: Cephalo Pro on laptop \(key ending 4d51\)/);
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
  const r = await proCommand(["activate", KEY], { ...w.deps, fetch: mockApi({ activate: goodActivate() }).fetch });
  assert.equal(r.exitCode, 0);
  assert.match(r.lines.join("\n"), /The Pro package is installed\. Try: cephalo bench/);
});

test("a Team key is recognised by its product, and a Pro key by its own; the store must be ours", async () => {
  const team = await proCommand(["activate", KEY], { ...world().deps, fetch: mockApi({ activate: goodActivate(LS_TEAM_PRODUCT_ID) }).fetch });
  assert.match(team.lines[0]!, /Cephalo Team/);
  const pro = await proCommand(["activate", KEY], { ...world().deps, fetch: mockApi({ activate: goodActivate(LS_PRO_PRODUCT_ID) }).fetch });
  assert.match(pro.lines[0]!, /Cephalo Pro/);
  const elsewhere = mockApi({ activate: () => ({ ...(goodActivate()() as object), meta: { store_id: 999, product_id: LS_PRO_PRODUCT_ID } }), deactivate: () => ({ deactivated: true }) });
  const w = world();
  const r = await proCommand(["activate", KEY], { ...w.deps, fetch: elsewhere.fetch });
  assert.equal(r.exitCode, 1);
  assert.match(r.lines[0]!, /not a Cephalo Pro or Team key/);
  assert.ok(!fs.existsSync(licensePath(w.dir)));
  assert.deepEqual(elsewhere.calls.map((c) => c.action), ["activate", "deactivate"], "the seat is given back");
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
  const r = await proCommand(["activate", KEY], { ...w.deps, fetch: mockApi({ activate: () => ({ activated: false, error: "This license key has reached the activation limit." }) }).fetch });
  assert.equal(r.exitCode, 1);
  assert.match(r.lines[0]!, /Could not activate: the license server said: This license key has reached the activation limit\./);
  assert.ok(!fs.existsSync(licensePath(w.dir)));
  assert.equal(w.npmCalls.length, 0);
  assert.equal((await proCommand(["activate"], w.deps)).exitCode, 1, "no terminal and no key");
  assert.match((await proCommand(["activate"], w.deps)).lines[0]!, /No license key/);
  const fromEnv = world({ env: { CEPHALO_LICENSE_KEY: KEY } });
  assert.equal((await proCommand(["activate"], { ...fromEnv.deps, fetch: mockApi({ activate: goodActivate() }).fetch })).exitCode, 0, "the key can come from the environment");
  const asked = world({ readKey: async () => KEY });
  assert.equal((await proCommand(["activate"], { ...asked.deps, fetch: mockApi({ activate: goodActivate() }).fetch })).exitCode, 0, "the hidden prompt supplies it");
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
  assert.match(r.lines[0]!, /Plan: Pro \(a@example\.com\), key ending 4d51, on laptop/);
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
  const bad = await proCommand(["renew", KEY], { ...w.deps, fetch: mockApi({ validate: () => ({ valid: false, license_key: { status: "disabled" } }) }).fetch });
  assert.equal(bad.exitCode, 1);
  assert.match(bad.lines[0]!, /not renewed: the license is disabled/);
  assert.equal(licenseState(readLicense(licensePath(w.dir)), NOW).state, "stale");
  const ok = await proCommand(["renew", KEY], { ...w.deps, fetch: mockApi({ validate: () => ({ valid: true, license_key: { status: "active" }, meta: { store_id: LS_STORE_ID, product_id: LS_PRO_PRODUCT_ID } }) }).fetch });
  assert.equal(ok.exitCode, 0);
  assert.equal(licenseState(readLicense(licensePath(w.dir)), NOW).state, "active");
  assert.equal((await proCommand(["renew", KEY], world().deps)).exitCode, 1, "nothing to renew");
});

test("deactivate gives the seat back and removes the record; if the server refuses, nothing changes here", async () => {
  const w = world();
  writeLicense(record(), licensePath(w.dir));
  const no = await proCommand(["deactivate", KEY], { ...w.deps, fetch: mockApi({ deactivate: () => ({ deactivated: false, error: "boom" }) }).fetch });
  assert.equal(no.exitCode, 1);
  assert.ok(readLicense(licensePath(w.dir)), "still licensed here");
  const yes = await proCommand(["deactivate", KEY], { ...w.deps, fetch: mockApi({ deactivate: () => ({ deactivated: true }) }).fetch });
  assert.equal(yes.exitCode, 0);
  assert.ok(!fs.existsSync(licensePath(w.dir)));
  assert.match(yes.lines.join("\n"), /left alone/);
  assert.equal((await proCommand(["deactivate", KEY], w.deps)).exitCode, 0, "already none");
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
  assert.match(msg("not-installed"), /Lemon Squeezy order/);
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
